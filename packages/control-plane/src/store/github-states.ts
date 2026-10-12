/**
 * The short-lived state tokens that prove a redirect came back from GitHub.
 * Installing the App and creating one from a manifest are two redirects with
 * the same shape, so they share one reader here, parameterized by table.
 * These functions are authorization-blind on purpose: the caller has already
 * established the actor's Team role, and every state statement is
 * additionally bound to `actor.userId` so a stolen state token cannot be
 * redeemed by anyone else.
 */
import type postgres from "postgres";

import type { GitHubInstallationState, GitHubRedirectState, GitHubSetup } from "../types.ts";
import { expectRow } from "./expect-row.ts";
import { iso, nonEmpty, sha256, timestamp } from "./normalize.ts";
import type { Timestamp } from "./rows.ts";

/** The two tables that carry a pending redirect. */
type GitHubStateTable = "github_installation_states" | "github_app_manifest_states";

interface StateRow {
  state_hash: string;
  team_id: string;
  user_id: string;
  expires_at: Timestamp;
  consumed_at: Timestamp | null;
  created_at: Timestamp;
  return_origin: string | null;
  return_path: string | null;
  setup_kind: GitHubSetup["kind"] | null;
  installation_id: number | string | null;
}

const INSTALLATION_STATE_COLUMNS = `state_hash, team_id, user_id, expires_at, consumed_at, created_at,
  return_origin, return_path, setup_kind, installation_id`;

function mapState(row: StateRow, table: GitHubStateTable): GitHubRedirectState {
  return {
    stateHash: row.state_hash,
    teamId: row.team_id,
    userId: row.user_id,
    expiresAt: iso(row.expires_at, `${table}.expires_at`),
    consumedAt: iso(row.consumed_at, `${table}.consumed_at`),
    createdAt: iso(row.created_at, `${table}.created_at`),
    returnOrigin: row.return_origin ?? null,
  };
}

/** An install state carries the pane it returns to: the column is required, so a row without one is broken. */
function mapInstallationState(row: StateRow): GitHubInstallationState {
  return {
    ...mapState(row, "github_installation_states"),
    returnPath: nonEmpty(row.return_path ?? "", "returnPath"),
    setup: setupOf(row),
  };
}

function setupOf(row: StateRow): GitHubSetup | null {
  if (row.setup_kind === "request") return { kind: "request" };
  if (row.setup_kind === "install" && row.installation_id !== null) {
    return { kind: "install", installationId: Number(row.installation_id) };
  }
  return null;
}

export async function insertGitHubAppManifestState(
  sql: postgres.TransactionSql,
  input: { teamId: string; userId: string; stateHash: string; expiresAt: string },
): Promise<GitHubRedirectState> {
  const rows = await sql<StateRow[]>`
    insert into public.github_app_manifest_states (state_hash, team_id, user_id, expires_at)
    values (
      ${sha256(input.stateHash, "stateHash")}, ${nonEmpty(input.teamId, "teamId")}::uuid,
      ${nonEmpty(input.userId, "actor.userId")}::uuid, ${timestamp(input.expiresAt, "expiresAt")}
    )
    returning state_hash, team_id, user_id, expires_at, consumed_at, created_at, return_origin,
      null::text as return_path, null::text as setup_kind, null::bigint as installation_id
  `;
  return mapState(expectRow(rows, "github_app_manifest_states", "insert"), "github_app_manifest_states");
}

export async function insertGitHubInstallationState(
  sql: postgres.TransactionSql,
  input: { teamId: string; userId: string; stateHash: string; expiresAt: string; returnOrigin: string | null; returnPath: string },
): Promise<GitHubInstallationState> {
  const rows = await sql<StateRow[]>`
    insert into public.github_installation_states (state_hash, team_id, user_id, expires_at, return_origin, return_path)
    values (
      ${sha256(input.stateHash, "stateHash")}, ${nonEmpty(input.teamId, "teamId")}::uuid,
      ${nonEmpty(input.userId, "actor.userId")}::uuid, ${timestamp(input.expiresAt, "expiresAt")},
      ${input.returnOrigin}, ${nonEmpty(input.returnPath, "returnPath")}
    )
    returning ${sql.unsafe(INSTALLATION_STATE_COLUMNS)}
  `;
  return mapInstallationState(expectRow(rows, "github_installation_states", "insert"));
}

/**
 * The pending state for this actor, or null. The membership join is the second
 * lock: a token minted while the user was an admin stops working the moment
 * their role is taken away. Without a hash it is the actor's newest one that
 * GitHub's setup redirect has not yet recorded on: GitHub may drop the state
 * from the redirect that follows a request for an owner's approval.
 */
async function selectPendingStateRow(
  sql: postgres.TransactionSql,
  table: GitHubStateTable,
  input: { userId: string; stateHash: string | null },
): Promise<StateRow | null> {
  const installs = table === "github_installation_states";
  const returnPath = installs ? sql`state.return_path` : sql`null::text`;
  const setupKind = installs ? sql`state.setup_kind` : sql`null::text`;
  const installationId = installs ? sql`state.installation_id` : sql`null::bigint`;
  const unrecorded = installs ? sql`state.setup_kind is null` : sql`true`;
  const hash = input.stateHash === null ? null : sha256(input.stateHash, "stateHash");
  const rows = await sql<StateRow[]>`
    select state.state_hash, state.team_id, state.user_id, state.expires_at,
      state.consumed_at, state.created_at, state.return_origin, ${returnPath} as return_path,
      ${setupKind} as setup_kind, ${installationId} as installation_id
    from ${sql(`public.${table}`)} state
    join public.team_memberships membership
      on membership.team_id = state.team_id
     and membership.user_id = state.user_id
     and membership.role = 'admin'
    where state.user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
      and (${hash}::text is null or state.state_hash = ${hash})
      and (${hash}::text is not null or ${unrecorded})
      and state.consumed_at is null
      and state.expires_at > clock_timestamp()
    order by state.created_at desc
    limit 1
  `;
  return rows[0] ?? null;
}

export async function selectPendingGitHubAppManifestState(
  sql: postgres.TransactionSql,
  input: { userId: string; stateHash: string },
): Promise<GitHubRedirectState | null> {
  const row = await selectPendingStateRow(sql, "github_app_manifest_states", input);
  return row ? mapState(row, "github_app_manifest_states") : null;
}

export async function selectPendingGitHubInstallationState(
  sql: postgres.TransactionSql,
  input: { userId: string; stateHash: string | null },
): Promise<GitHubInstallationState | null> {
  const row = await selectPendingStateRow(sql, "github_installation_states", input);
  return row ? mapInstallationState(row) : null;
}

/**
 * GitHub's setup redirect, recorded on the person's pending state — an install
 * naming its installation, or a request — under a new hash: the token GitHub
 * saw in the install URL stops working, and the new one is the authorization
 * step's own. Null when no pending state of theirs matches; without a hash it
 * is their newest unrecorded one, as a request's redirect may drop it.
 */
export async function recordGitHubInstallationSetup(
  sql: postgres.TransactionSql,
  input: { userId: string; stateHash: string | null; nextStateHash: string; setup: GitHubSetup },
): Promise<GitHubInstallationState | null> {
  const pending = await selectPendingStateRow(sql, "github_installation_states", input);
  if (!pending) return null;
  const installationId = input.setup.kind === "install" ? input.setup.installationId : null;
  const rows = await sql<StateRow[]>`
    update public.github_installation_states
    set state_hash = ${sha256(input.nextStateHash, "nextStateHash")},
        setup_kind = ${input.setup.kind}, installation_id = ${installationId}
    where state_hash = ${pending.state_hash} and consumed_at is null
    returning ${sql.unsafe(INSTALLATION_STATE_COLUMNS)}
  `;
  return rows[0] ? mapInstallationState(rows[0]) : null;
}

/**
 * The person declined GitHub's authorization: their state is spent, so the
 * pane stops reporting a connect in flight. The pane to return to, or null
 * when no pending state of theirs matches.
 */
export async function abandonGitHubInstallationState(
  sql: postgres.TransactionSql,
  input: { userId: string; stateHash: string },
): Promise<string | null> {
  const rows = await sql<Array<{ return_path: string }>>`
    update public.github_installation_states
    set consumed_at = now()
    where state_hash = ${sha256(input.stateHash, "stateHash")}
      and user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
      and consumed_at is null
      and expires_at > clock_timestamp()
    returning return_path
  `;
  return rows[0]?.return_path ?? null;
}

export async function consumeGitHubAppManifestState(
  sql: postgres.TransactionSql,
  input: { teamId: string; userId: string; stateHash: string },
): Promise<void> {
  const rows = await sql<Array<{ state_hash: string }>>`
    update public.github_app_manifest_states
    set consumed_at = now()
    where state_hash = ${sha256(input.stateHash, "stateHash")}
      and team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
      and consumed_at is null
      and expires_at > clock_timestamp()
    returning state_hash
  `;
  if (!rows[0]) throw new Error("GitHub App Manifest state is invalid, expired, or consumed.");
}

/** Spends an installation state inside the caller's transaction, or refuses one that is no longer redeemable. */
export async function consumeInstallationState(
  sql: postgres.TransactionSql,
  input: { teamId: string; userId: string; stateHash: string },
): Promise<void> {
  const rows = await sql<Array<{ state_hash: string }>>`
    update public.github_installation_states
    set consumed_at = now()
    where state_hash = ${sha256(input.stateHash, "stateHash")}
      and team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
      and consumed_at is null
      and expires_at > clock_timestamp()
    returning state_hash
  `;
  if (!rows[0]) throw new Error("GitHub installation state is invalid, expired, or consumed.");
}
