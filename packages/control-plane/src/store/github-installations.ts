/**
 * The connections the GitHub App handshake leaves: one row per GitHub
 * account a team connected — waiting for an owner's approval, reading, or
 * revoked on GitHub. The state tokens the handshake spends are in
 * github-states.ts. These functions are authorization-blind on purpose: the
 * caller has already established the actor's Team role.
 */
import type postgres from "postgres";

import type {
  GitHubAccountType,
  GitHubInstallation,
  GitHubInstallationInput,
  GitHubInstallationStatus,
} from "../types.ts";
import { expectRow } from "./expect-row.ts";
import { consumeInstallationState } from "./github-states.ts";
import { iso, nonEmpty, positiveInteger, timestamp } from "./normalize.ts";
import type { Timestamp } from "./rows.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

interface ConnectionRow {
  id: string;
  team_id: string;
  installation_id: number | string | null;
  github_account_id: number | string;
  github_account_login: string;
  account_type: GitHubAccountType;
  status: GitHubInstallationStatus;
  installed_by: string | null;
  created_at: Timestamp;
  connected_at: Timestamp | null;
  revoked_at: Timestamp | null;
}

const CONNECTION_COLUMNS = `
  installation.id, installation.team_id, installation.installation_id,
  installation.github_account_id, installation.github_account_login,
  installation.account_type, installation.status,
  profile.display_name as installed_by,
  installation.created_at, installation.connected_at, installation.revoked_at
`;

function mapConnection(row: ConnectionRow): GitHubInstallation {
  return {
    id: row.id,
    teamId: row.team_id,
    installationId: row.installation_id === null ? null : Number(row.installation_id),
    githubAccountId: Number(row.github_account_id),
    githubAccountLogin: row.github_account_login,
    accountType: row.account_type,
    status: row.status,
    installedBy: row.installed_by,
    createdAt: iso(row.created_at, "github_installations.created_at"),
    connectedAt: iso(row.connected_at, "github_installations.connected_at"),
    revokedAt: iso(row.revoked_at, "github_installations.revoked_at"),
  };
}

async function selectConnection(sql: Queryable, teamId: string, id: string): Promise<GitHubInstallation> {
  const rows = await sql<ConnectionRow[]>`
    select ${sql.unsafe(CONNECTION_COLUMNS)}
    from public.github_installations installation
    left join public.user_profiles profile on profile.user_id = installation.created_by
    where installation.id = ${id}::uuid and installation.team_id = ${teamId}::uuid
  `;
  return mapConnection(expectRow(rows, "github_installations", "select"));
}

/**
 * Once an account's installation belongs to one team, every other team's
 * request for that account is void: the installation can never be theirs,
 * and left pending it would wait forever — or be claimed by a later poll.
 */
async function clearOtherPendingRequests(sql: postgres.TransactionSql, accountId: number, keptId: string): Promise<void> {
  await sql`
    delete from public.github_installations
    where github_account_id = ${accountId} and status = 'pending' and id <> ${keptId}::uuid
  `;
}

/**
 * Redeems an installation state and records the installation it authorized.
 * The row is the team's connection to that GitHub account: a reconnect after
 * the install was deleted re-points it, so its bindings read again. An
 * installation id belongs to exactly one Team for life — re-pointing it would
 * silently hand one Team's repositories to another.
 */
export async function completeGitHubInstallationRow(
  sql: postgres.TransactionSql,
  input: { teamId: string; userId: string; stateHash: string; installation: GitHubInstallationInput },
): Promise<GitHubInstallation> {
  const teamId = nonEmpty(input.teamId, "teamId");
  const userId = nonEmpty(input.userId, "actor.userId");
  const installationId = positiveInteger(input.installation.installationId, "installationId");
  const accountId = positiveInteger(input.installation.githubAccountId, "githubAccountId");
  const accountLogin = nonEmpty(input.installation.githubAccountLogin, "githubAccountLogin");
  await consumeInstallationState(sql, { teamId, userId, stateHash: input.stateHash });
  const conflicts = await sql<Array<{ team_id: string }>>`
    select team_id from public.github_installations
    where installation_id = ${installationId} and team_id <> ${teamId}::uuid
    for update
  `;
  if (conflicts[0]) throw new Error("GitHub installation already belongs to another Team.");
  const rows = await sql<Array<{ id: string }>>`
    insert into public.github_installations (
      team_id, installation_id, github_account_id, github_account_login,
      account_type, status, created_by, connected_at
    ) values (
      ${teamId}::uuid, ${installationId}, ${accountId}, ${accountLogin},
      ${input.installation.accountType}, 'active', ${userId}::uuid, now()
    )
    on conflict (team_id, github_account_id) do update
    set installation_id = excluded.installation_id,
        github_account_login = excluded.github_account_login,
        account_type = excluded.account_type,
        status = 'active',
        connected_at = coalesce(public.github_installations.connected_at, now()),
        revoked_at = null,
        updated_at = now()
    returning id
  `;
  const id = expectRow(rows, "github_installations", "insert").id;
  await clearOtherPendingRequests(sql, accountId, id);
  await sql`
    update public.project_repositories set access_status = 'ready', updated_at = now()
    where github_installation_id = ${id}::uuid and access_status = 'reconnect_required'
  `;
  return selectConnection(sql, teamId, id);
}

/**
 * Records the account an organization member asked its owners to approve
 * the App on. Nothing reads through it until an owner approves; an account
 * this team already reads through stays as it is.
 */
export async function requestGitHubInstallationRow(
  sql: postgres.TransactionSql,
  input: {
    teamId: string;
    userId: string;
    stateHash: string;
    account: { id: number; login: string; type: GitHubAccountType };
  },
): Promise<void> {
  const teamId = nonEmpty(input.teamId, "teamId");
  const userId = nonEmpty(input.userId, "actor.userId");
  await consumeInstallationState(sql, { teamId, userId, stateHash: input.stateHash });
  await sql`
    insert into public.github_installations (
      team_id, installation_id, github_account_id, github_account_login,
      account_type, status, created_by
    ) values (
      ${teamId}::uuid, null, ${positiveInteger(input.account.id, "githubAccountId")},
      ${nonEmpty(input.account.login, "githubAccountLogin")}, ${input.account.type},
      'pending', ${userId}::uuid
    )
    on conflict (team_id, github_account_id) do nothing
  `;
}

/** Every GitHub account the team connected, oldest first. */
export async function selectGitHubConnections(sql: Queryable, teamId: string): Promise<GitHubInstallation[]> {
  const rows = await sql<ConnectionRow[]>`
    select ${sql.unsafe(CONNECTION_COLUMNS)}
    from public.github_installations installation
    left join public.user_profiles profile on profile.user_id = installation.created_by
    where installation.team_id = ${nonEmpty(teamId, "teamId")}::uuid
    order by installation.created_at, installation.id
  `;
  return rows.map(mapConnection);
}

/** One connection of the team, or null. */
export async function selectGitHubConnection(
  sql: Queryable,
  teamId: string,
  id: string,
): Promise<GitHubInstallation | null> {
  const rows = await sql<ConnectionRow[]>`
    select ${sql.unsafe(CONNECTION_COLUMNS)}
    from public.github_installations installation
    left join public.user_profiles profile on profile.user_id = installation.created_by
    where installation.id = ${nonEmpty(id, "connectionId")}::uuid
      and installation.team_id = ${nonEmpty(teamId, "teamId")}::uuid
  `;
  return rows[0] ? mapConnection(rows[0]) : null;
}

/** The slug of the actor's Team that owns this installation, or null. */
export async function selectInstallationTeamSlug(
  sql: Queryable,
  input: { userId: string; installationId: number },
): Promise<string | null> {
  const rows = await sql<Array<{ slug: string }>>`
    select team.slug
    from public.github_installations installation
    join public.teams team on team.id = installation.team_id
    join public.team_memberships membership
      on membership.team_id = installation.team_id
     and membership.user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
    where installation.installation_id = ${positiveInteger(input.installationId, "installationId")}
  `;
  return rows[0]?.slug ?? null;
}

/**
 * An owner approved: the pending row takes the installation, and every other
 * team's request for the account goes. An installation another team already
 * holds is not this team's to take, so its request goes instead.
 */
async function approvePendingConnection(
  sql: postgres.TransactionSql,
  connectionId: string,
  installationId: number,
): Promise<void> {
  const held = await sql`
    select 1 from public.github_installations
    where installation_id = ${installationId} and id <> ${connectionId}::uuid
    for update
  `;
  if (held[0]) {
    await sql`delete from public.github_installations where id = ${connectionId}::uuid and status = 'pending'`;
    return;
  }
  const approved = await sql<Array<{ github_account_id: number | string }>>`
    update public.github_installations
    set installation_id = ${installationId}, status = 'active', connected_at = now(), updated_at = now()
    where id = ${connectionId}::uuid and status = 'pending'
    returning github_account_id
  `;
  if (approved[0]) await clearOtherPendingRequests(sql, Number(approved[0].github_account_id), connectionId);
}

/** What GitHub was seen to do to a connection. Each change is only applied from the state it follows. */
export type GitHubConnectionChange =
  | { kind: "approved"; installationId: number }
  | { kind: "declined" }
  | { kind: "revoked"; at: string }
  | { kind: "restored" };

export async function applyGitHubConnectionChange(
  sql: postgres.TransactionSql,
  id: string,
  change: GitHubConnectionChange,
): Promise<void> {
  const connectionId = nonEmpty(id, "connectionId");
  if (change.kind === "approved") {
    await approvePendingConnection(sql, connectionId, positiveInteger(change.installationId, "installationId"));
    return;
  }
  if (change.kind === "declined") {
    await sql`delete from public.github_installations where id = ${connectionId}::uuid and status = 'pending'`;
    return;
  }
  const revoked = change.kind === "revoked";
  const updated = await sql`
    update public.github_installations
    set status = ${revoked ? "revoked" : "active"},
        revoked_at = ${revoked ? timestamp(change.at, "revokedAt") : null}, updated_at = now()
    where id = ${connectionId}::uuid and status = ${revoked ? "active" : "revoked"}
    returning id
  `;
  if (!updated[0]) return;
  await sql`
    update public.project_repositories
    set access_status = ${revoked ? "reconnect_required" : "ready"}, updated_at = now()
    where github_installation_id = ${connectionId}::uuid
      and access_status = ${revoked ? "ready" : "reconnect_required"}
  `;
}

/**
 * Forgets a connection and the bindings made through it. Nothing changes on
 * GitHub: the installation and the repositories it may read are the owner's.
 */
export async function deleteGitHubConnection(
  sql: postgres.TransactionSql,
  teamId: string,
  id: string,
): Promise<void> {
  const connectionId = nonEmpty(id, "connectionId");
  const scopedTeamId = nonEmpty(teamId, "teamId");
  await sql`
    delete from public.project_repositories
    where github_installation_id = ${connectionId}::uuid and team_id = ${scopedTeamId}::uuid
  `;
  const rows = await sql`
    delete from public.github_installations
    where id = ${connectionId}::uuid and team_id = ${scopedTeamId}::uuid
    returning id
  `;
  if (!rows[0]) throw new Error("GitHub connection not found.");
}
