/**
 * The Slack handshake: the short-lived state tokens that prove a redirect came
 * back from Slack, and the workspace rows they mint.
 *
 * Two derived facts live here rather than in a column. A workspace is
 * *revoked* when `revoked_at` is set — the row is otherwise untouched, so
 * reconnecting is an upsert and not a rebuild. An install is *unfinished*
 * when the team's latest unconsumed state is recent and nothing has been
 * connected since it was started: Slack never calls back when an install
 * needs a workspace admin's approval, so there is nothing to store, nothing
 * to time out, and no way to claim an admin was actually asked.
 *
 * These functions are authorization-blind on purpose: the caller has already
 * established the actor's Team role, and every statement is additionally bound
 * to the team or to `actor.userId`.
 */
import { isSameSitePath } from "@shipbash/contracts/same-site-path";
import type postgres from "postgres";

import type { ConsumeInstallStateResult } from "../install-state.ts";
import { type SignInKeyring, SignInCryptoError } from "../sign-in-crypto.ts";
import type { SlackInstallation } from "../slack-app.ts";
import { expectRow } from "./expect-row.ts";
import { iso, nonEmpty, sha256, timestamp } from "./normalize.ts";
import { type SlackChannelBinding, selectSlackChannelBindings } from "./slack-channel-bindings.ts";
import { sealingKey } from "./slack-workspace-token.ts";
import type { SelectedRow, Timestamp } from "./table-rows.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

type WorkspaceRow = SelectedRow<
  "slack_workspaces",
  "id" | "slack_team_id" | "slack_team_name" | "icon_url" | "connected_by" | "connected_at" | "revoked_at",
  { connected_by_name: string | null; connected_at: Timestamp; revoked_at: Timestamp | null }
>;

type PendingRow = SelectedRow<
  "slack_install_states",
  "created_at",
  { started_by_name: string | null; created_at: Timestamp }
>;

type StateRow = SelectedRow<
  "slack_install_states",
  "state_hash" | "team_id" | "user_id" | "consumed_at",
  { created_at: Timestamp; expires_at: Timestamp; consumed_at: Timestamp | null }
>;

/** The connection itself, with nothing said about what routes through it. */
export interface SlackWorkspaceConnection {
  id: string;
  slackTeamId: string;
  name: string;
  iconUrl: string | null;
  /** Who installed it, as the team knows them; null when their profile is gone. */
  connectedBy: string | null;
  connectedAt: string;
  /** Set means Slack stopped honouring the token; every other field is unchanged. */
  revokedAt: string | null;
}

/** One workspace card: the connection, plus only the projects that alert into it. */
export interface SlackWorkspace extends SlackWorkspaceConnection {
  bindings: SlackChannelBinding[];
  /** What its silence cost, summed over those projects: a project that no longer alerts here is no longer its loss. */
  unannouncedFailures: number;
}

/**
 * An install this team started and never finished. It carries no deadline,
 * because we cannot know whether a Slack admin was ever asked: all the pane
 * can honestly say is when it was started.
 */
export interface SlackPendingInstall {
  startedBy: string | null;
  startedAt: string;
}

export interface SlackConnections {
  workspaces: SlackWorkspace[];
  pendingInstall: SlackPendingInstall | null;
}

/** The one row→view mapping; every read of a workspace goes through it. */
function mapWorkspace(row: WorkspaceRow): SlackWorkspaceConnection {
  return {
    id: row.id,
    slackTeamId: row.slack_team_id,
    name: row.slack_team_name,
    iconUrl: row.icon_url,
    connectedBy: row.connected_by_name,
    connectedAt: iso(row.connected_at, "slack_workspaces.connected_at"),
    revokedAt: iso(row.revoked_at, "slack_workspaces.revoked_at"),
  };
}

/** How long a return address may be; the column's CHECK is the coarse backstop. */
const MAX_RETURN_PATH_LENGTH = 1_024;

/**
 * How long an unfinished install stays on the pane. Long enough for a Slack
 * admin to get to it, short enough that an install nobody ever finished stops
 * claiming to be in progress. It is not the state's ten-minute redemption
 * window, and stretching that window to cover this would have let a week-old
 * redirect be redeemed.
 */
const UNFINISHED_INSTALL_WINDOW = "7 days";

/**
 * Settings addresses name the team and the project in scope, and Slack's
 * redirect back carries neither, so the address the install was started from
 * is stored with the state. The value ends up in a `Location`, so it is held
 * to the product's one open-redirect guard rather than a second reading of it.
 */
export function slackReturnPath(value: string): string {
  const path = value.trim();
  if (!path || path.length > MAX_RETURN_PATH_LENGTH || !isSameSitePath(path)) {
    throw new Error("returnPath must be a same-site path.");
  }
  return path;
}

export async function insertSlackInstallState(
  sql: postgres.TransactionSql,
  input: { teamId: string; userId: string; stateHash: string; expiresAt: string; returnPath: string },
): Promise<void> {
  await sql`
    insert into public.slack_install_states (state_hash, team_id, user_id, return_path, expires_at)
    values (
      ${sha256(input.stateHash, "stateHash")}, ${nonEmpty(input.teamId, "teamId")}::uuid,
      ${nonEmpty(input.userId, "actor.userId")}::uuid, ${slackReturnPath(input.returnPath)},
      ${timestamp(input.expiresAt, "expiresAt")}
    )
  `;
}

/**
 * The install this redirect belongs to, read without spending it. The
 * membership join is the second lock: a token minted while the user was an
 * admin stops working the moment their role is taken away.
 */
export async function selectPendingSlackInstall(
  sql: Queryable,
  input: { userId: string; stateHash: string },
): Promise<{ teamId: string; returnPath: string } | null> {
  const rows = await sql<Array<{ team_id: string; return_path: string }>>`
    select state.team_id, state.return_path
    from public.slack_install_states state
    join public.team_memberships membership
      on membership.team_id = state.team_id
     and membership.user_id = state.user_id
     and membership.role = 'admin'
    where state.state_hash = ${sha256(input.stateHash, "stateHash")}
      and state.user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
      and state.consumed_at is null
      and state.expires_at > clock_timestamp()
    limit 1
  `;
  const row = rows[0];
  return row ? { teamId: row.team_id, returnPath: row.return_path } : null;
}

/**
 * Compares the user and consumes the row in one transaction: the select locks
 * it, so a replayed redirect racing the first one reads `consumed` rather than
 * redeeming the same install twice.
 */
export async function consumeSlackInstallState(
  sql: postgres.TransactionSql,
  input: { stateHash: string; expectedUserId: string; now: string },
): Promise<ConsumeInstallStateResult> {
  const stateHash = sha256(input.stateHash, "stateHash");
  const rows = await sql<StateRow[]>`
    select state_hash, team_id, user_id, consumed_at, created_at, expires_at
    from public.slack_install_states
    where state_hash = ${stateHash}
    for update
  `;
  const row = rows[0];
  if (!row) return { status: "missing" };
  if (row.consumed_at !== null) return { status: "consumed" };
  if (row.user_id !== nonEmpty(input.expectedUserId, "actor.userId")) {
    return { status: "user_mismatch" };
  }
  if (Date.parse(iso(row.expires_at, "slack_install_states.expires_at")) <= Date.parse(timestamp(input.now, "now"))) {
    return { status: "expired" };
  }
  await sql`
    update public.slack_install_states set consumed_at = now() where state_hash = ${stateHash}
  `;
  return {
    status: "ok",
    record: {
      stateHash: row.state_hash,
      teamId: row.team_id,
      userId: row.user_id,
      createdAt: iso(row.created_at, "slack_install_states.created_at"),
      expiresAt: iso(row.expires_at, "slack_install_states.expires_at"),
    },
  };
}

/**
 * One answered redirect. The user said no on Slack's consent screen, so the
 * state is spent: leaving it unconsumed would keep the pane claiming an
 * install is still in flight when the person has already declined it.
 */
export async function consumeSlackInstallStateAfterDenial(
  sql: Queryable,
  input: { userId: string; stateHash: string },
): Promise<void> {
  await sql`
    update public.slack_install_states
    set consumed_at = now()
    where state_hash = ${sha256(input.stateHash, "stateHash")}
      and user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
      and consumed_at is null
  `;
}

/** Everything this team started and never finished stops being offered. */
export async function discardSlackInstallStates(
  sql: postgres.TransactionSql,
  teamId: string,
): Promise<void> {
  await sql`
    delete from public.slack_install_states
    where team_id = ${nonEmpty(teamId, "teamId")}::uuid and consumed_at is null
  `;
}

/**
 * Records a completed install; a reconnect is the same statement, so delivery never resumes against a
 * token that was not stored. Scopes belong to the workspace's one bot token, which every ShipBash team
 * installed there shares, so the other teams' live rows take them too.
 */
export async function upsertSlackWorkspace(
  sql: postgres.TransactionSql,
  keyring: SignInKeyring,
  input: { teamId: string; userId: string; installation: SlackInstallation },
): Promise<SlackWorkspaceConnection> {
  const teamId = nonEmpty(input.teamId, "teamId");
  const userId = nonEmpty(input.userId, "actor.userId");
  const { installation } = input;
  const sealed = keyring.seal(
    sealingKey(teamId, installation.slackTeamId),
    nonEmpty(installation.botToken, "botToken"),
  );
  const rows = await sql<WorkspaceRow[]>`
    with saved as (
      insert into public.slack_workspaces (
        team_id, slack_team_id, slack_team_name, icon_url, bot_user_id,
        bot_token_ciphertext, encryption_key_id, scopes, connected_by
      ) values (
        ${teamId}::uuid, ${installation.slackTeamId},
        ${nonEmpty(installation.slackTeamName, "slackTeamName")}, ${installation.iconUrl},
        ${installation.botUserId}, ${sealed.envelope}, ${sealed.keyId},
        ${installation.scopes}, ${userId}::uuid
      )
      on conflict (team_id, slack_team_id) do update
      set slack_team_name = excluded.slack_team_name,
          icon_url = excluded.icon_url,
          bot_user_id = excluded.bot_user_id,
          bot_token_ciphertext = excluded.bot_token_ciphertext,
          encryption_key_id = excluded.encryption_key_id,
          scopes = excluded.scopes,
          connected_by = excluded.connected_by,
          connected_at = now(),
          revoked_at = null
      returning id, slack_team_id, slack_team_name, icon_url, connected_by, connected_at, revoked_at
    ), shared as (
      update public.slack_workspaces set scopes = ${installation.scopes}
      where slack_team_id = ${installation.slackTeamId} and team_id <> ${teamId}::uuid and revoked_at is null
    )
    select saved.*, profile.display_name as connected_by_name
    from saved
    left join public.user_profiles profile on profile.user_id = saved.connected_by
  `;
  return mapWorkspace(expectRow(rows, "slack_workspaces", "insert"));
}

/** The team's cards, plus the install it is still waiting on. */
export async function selectSlackConnections(
  sql: Queryable,
  teamId: string,
): Promise<SlackConnections> {
  const scopedTeamId = nonEmpty(teamId, "teamId");
  const workspaces = await sql<WorkspaceRow[]>`
    select workspace.id, workspace.slack_team_id, workspace.slack_team_name,
      workspace.icon_url, workspace.connected_by, workspace.connected_at,
      workspace.revoked_at, profile.display_name as connected_by_name
    from public.slack_workspaces workspace
    left join public.user_profiles profile on profile.user_id = workspace.connected_by
    where workspace.team_id = ${scopedTeamId}::uuid
    order by workspace.connected_at, workspace.id
  `;
  // What the pane calls unfinished is not the state's security window. That
  // window is ten minutes and gates redemption; an install held up by a Slack
  // admin waits hours or days, and dropping it off the pane after ten minutes
  // would hide the very thing the pane is for. So: this team's latest
  // unconsumed install, started recently enough to still be about something,
  // with no workspace connected since it started. A `denied` callback consumes
  // its own state, and a completed install is named by the connected_at
  // comparison rather than by a sweeper.
  const pending = await sql<PendingRow[]>`
    select state.created_at, profile.display_name as started_by_name
    from public.slack_install_states state
    left join public.user_profiles profile on profile.user_id = state.user_id
    where state.team_id = ${scopedTeamId}::uuid
      and state.consumed_at is null
      and state.created_at > now() - ${UNFINISHED_INSTALL_WINDOW}::interval
      and state.created_at > coalesce((
        select max(workspace.connected_at)
        from public.slack_workspaces workspace
        where workspace.team_id = state.team_id
      ), '-infinity'::timestamptz)
    order by state.created_at desc
    limit 1
  `;
  const waiting = pending[0];
  const bindings = await selectSlackChannelBindings(sql, scopedTeamId);
  return {
    workspaces: workspaces.map((row) => {
      const routed = bindings.get(row.id) ?? [];
      const lost = routed.reduce((total, binding) => total + binding.unannouncedFailures, 0);
      return { ...mapWorkspace(row), bindings: routed, unannouncedFailures: lost };
    }),
    pendingInstall: waiting
      ? {
          startedBy: waiting.started_by_name,
          startedAt: iso(waiting.created_at, "slack_install_states.created_at"),
        }
      : null,
  };
}

/**
 * Forgets a workspace and hands back its bot token — but only when no other
 * ShipBash team is still installed into that Slack workspace.
 *
 * Slack issues one bot token per app per workspace, so two teams connected to
 * the same workspace hold the same token, and revoking it because one of them
 * tidied up would silence the other. The check runs inside the delete's own
 * statement, so a concurrent disconnect cannot miss the row this one is
 * removing and conclude it is alone too. The row goes either way: a token
 * ShipBash no longer holds cannot deliver, whatever Slack was told.
 */
export async function deleteSlackWorkspace(
  sql: postgres.TransactionSql,
  keyring: SignInKeyring | null,
  input: { teamId: string; workspaceId: string },
): Promise<string | null> {
  const rows = await sql<
    Array<{ slack_team_id: string; bot_token_ciphertext: string; shared: boolean }>
  >`
    with removed as (
      delete from public.slack_workspaces
      where team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
        and id = ${nonEmpty(input.workspaceId, "workspaceId")}::uuid
      returning id, slack_team_id, bot_token_ciphertext
    )
    select removed.slack_team_id, removed.bot_token_ciphertext,
      exists (
        select 1 from public.slack_workspaces other
        where other.slack_team_id = removed.slack_team_id
          -- Every statement in a data-modifying CTE reads the same snapshot,
          -- so the row being deleted is still visible here and would count
          -- itself as another team's install.
          and other.id <> removed.id
      ) as shared
    from removed
  `;
  const row = rows[0];
  if (!row || row.shared) return null;
  if (!keyring) {
    throw new SignInCryptoError(
      "unconfigured",
      "This Slack workspace is sealed, and no sign-in encryption key is configured.",
    );
  }
  return keyring.open(sealingKey(input.teamId.trim(), row.slack_team_id), row.bot_token_ciphertext);
}

/**
 * Slack said the app is gone from this workspace. Every ShipBash team that
 * installed it stops delivering; nothing else about the connection changes.
 */
export async function revokeSlackWorkspaces(
  sql: Queryable,
  slackTeamId: string,
): Promise<number> {
  const rows = await sql<Array<{ id: string }>>`
    update public.slack_workspaces
    set revoked_at = now()
    where slack_team_id = ${nonEmpty(slackTeamId, "slackTeamId")} and revoked_at is null
    returning id
  `;
  return rows.length;
}
