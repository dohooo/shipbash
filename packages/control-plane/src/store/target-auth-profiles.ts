/**
 * Target Auth Profile reads and host-side writes: the member health read,
 * the ensure that pins a profile to the Project's Production origin (origin
 * mismatch is refused), and the verifying flip guarded by the base state
 * version. A write that makes a sign-in ready is target-auth-state.ts's.
 */
import type postgres from "postgres";

import { generatedTextId, iso, nonEmpty } from "./normalize.ts";
import { normalizeProductionUrl } from "./production-url.ts";
import type { Timestamp } from "./rows.ts";
import type { TargetAuthProfileStatus } from "@shipbash/contracts/database-contract-types";
import type { TenantActor } from "../types.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** The seed account's health for this project, or null before first setup. */
export async function getProjectAuthProfile(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
): Promise<{
  status: TargetAuthProfileStatus;
  productionOrigin: string;
  lastVerifiedAt: string | null;
  failureReason: string | null;
} | null> {
  const rows = await sql<Array<{
    status: TargetAuthProfileStatus;
    production_origin: string;
    last_verified_at: Timestamp | null;
    failure_reason: string | null;
  }>>`
    select profile.status, profile.production_origin, profile.last_verified_at,
      profile.failure_reason
    from public.team_memberships membership
    join public.target_auth_profiles profile on profile.team_id = membership.team_id
    where membership.team_id = ${scopedTeamId}::uuid
      and membership.user_id = ${nonEmpty(actor.userId, "actor.userId")}::uuid
      and profile.project_id = ${scopedProjectId}
    order by profile.updated_at desc limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status,
    productionOrigin: row.production_origin,
    lastVerifiedAt: iso(row.last_verified_at, "target_auth_profiles.last_verified_at"),
    failureReason: row.failure_reason,
  };
}

export async function ensureTargetAuthProfile(
  sql: postgres.Sql,
  teamId: string,
  projectId: string,
  productionUrl: string,
): Promise<{
  id: string;
  status: "missing" | "verifying" | "ready" | "expired" | "failed";
  stateVersion: string | null;
}> {
  const scopedTeamId = nonEmpty(teamId, "teamId");
  const scopedProjectId = nonEmpty(projectId, "projectId");
  const productionOrigin = new URL(normalizeProductionUrl(productionUrl)).origin;
  return await sql.begin(async (sql) => {
    const projects = await sql<Array<{ production_url: string | null }>>`
      select production_url from public.projects
      where id = ${scopedProjectId} and team_id = ${scopedTeamId}::uuid
      for share
    `;
    if (!projects[0]?.production_url || new URL(projects[0].production_url).origin !== productionOrigin) {
      throw new Error("Target Auth Profile origin does not match the Project Production URL.");
    }
    const locator = `runner-workspace:${scopedProjectId}:target-auth:default`;
    const rows = await sql<Array<{
      id: string;
      status: "missing" | "verifying" | "ready" | "expired" | "failed";
      state_version: string | null;
    }>>`
      insert into public.target_auth_profiles (
        id, project_id, team_id, production_origin, status,
        profile_locator, state_locator
      ) values (
        ${generatedTextId("auth_profile")}, ${scopedProjectId}, ${scopedTeamId}::uuid,
        ${productionOrigin}, 'missing', ${`${locator}:profile`}, ${`${locator}:state`}
      )
      on conflict (project_id, production_origin) do update
      set team_id = excluded.team_id
      returning id, status, state_version
    `;
    const row = rows[0];
    if (!row) throw new Error("Target Auth Profile could not be prepared.");
    return { id: row.id, status: row.status, stateVersion: row.state_version };
  });
}

export async function markTargetAuthProfileVerifying(
  sql: postgres.Sql,
  teamId: string,
  projectId: string,
  profileId: string,
  baseStateVersion: string | null,
): Promise<boolean> {
  const rows = await sql`
    update public.target_auth_profiles
    set status = 'verifying', failure_reason = null, updated_at = now()
    where id = ${nonEmpty(profileId, "profileId")}
      and team_id = ${nonEmpty(teamId, "teamId")}::uuid
      and project_id = ${nonEmpty(projectId, "projectId")}
      and state_version is not distinct from ${baseStateVersion}
    returning id
  `;
  return Boolean(rows[0]);
}
