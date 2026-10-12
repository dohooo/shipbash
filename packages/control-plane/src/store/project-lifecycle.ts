/**
 * Project lifecycle for the Console: the membership-scoped list/get, the
 * soft-delete archive (runs and evidence stay), and the settings update
 * (a Production URL change invalidates trusted access verified against the
 * old origin). The tenant-store facade owns actor scoping and role checks.
 */
import type postgres from "postgres";

import { isAgentRuntime, type AgentRuntime } from "@shipbash/contracts/model-contract";
import { nonEmpty } from "./normalize.ts";
import { assertProductionUrlAvailable } from "./production-url.ts";
import { PROJECT_ROW_COLUMNS, type ProjectRow } from "./rows.ts";
import { mapProject } from "./workspace-maps.ts";
import type { TenantActor, TenantProject } from "../types.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** Callers that omit the runtime get pi, the one runtime ShipBash speaks. */
export function normalizeAgentRuntime(value: unknown): AgentRuntime {
  if (value === undefined || value === null) return "pi";
  if (!isAgentRuntime(value)) throw new Error("agentRuntime must be 'pi'.");
  return value;
}

export async function listProjects(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
): Promise<TenantProject[]> {
  const rows = await sql<ProjectRow[]>`
    select project.id, project.team_id, project.slug, project.name, project.production_url,
      project.testing_context, project.agent_runtime, project.lifecycle_status,
      project.created_at, project.updated_at
    from public.team_memberships membership
    join public.projects project on project.team_id = membership.team_id
    where membership.team_id = ${scopedTeamId}::uuid
      and membership.user_id = ${nonEmpty(actor.userId, "actor.userId")}::uuid
      and project.lifecycle_status <> 'archived'
    order by lower(project.name), project.id
  `;
  return rows.map((row) => mapProject(row));
}

export async function getProject(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
): Promise<TenantProject | null> {
  const rows = await sql<ProjectRow[]>`
    select project.id, project.team_id, project.slug, project.name, project.production_url,
      project.testing_context, project.agent_runtime, project.lifecycle_status,
      project.created_at, project.updated_at
    from public.team_memberships membership
    join public.projects project on project.team_id = membership.team_id
    where membership.team_id = ${scopedTeamId}::uuid
      and membership.user_id = ${nonEmpty(actor.userId, "actor.userId")}::uuid
      and project.id = ${scopedProjectId}
    limit 1
  `;
  return rows[0] ? mapProject(rows[0]) : null;
}

/** Soft-deletes a project: it disappears from listings while its runs and evidence stay in the database. */
export async function archiveProject(
  sql: postgres.TransactionSql,
  scopedTeamId: string,
  scopedProjectId: string,
): Promise<TenantProject> {
  const rows = await sql<ProjectRow[]>`
    update public.projects
    set lifecycle_status = 'archived', updated_at = now()
    where id = ${scopedProjectId} and team_id = ${scopedTeamId}::uuid
      and lifecycle_status <> 'archived'
    returning ${sql(PROJECT_ROW_COLUMNS)}
  `;
  if (rows[0]) return mapProject(rows[0]);
  // Archiving twice is one wish granted once: the second DELETE answers with
  // the archived row instead of dressing the same outcome up as a 404.
  const archived = await sql<ProjectRow[]>`
    select ${sql(PROJECT_ROW_COLUMNS)} from public.projects
    where id = ${scopedProjectId} and team_id = ${scopedTeamId}::uuid
      and lifecycle_status = 'archived'
    limit 1
  `;
  if (!archived[0]) throw new Error("Active project not found.");
  return mapProject(archived[0]);
}

export async function updateProject(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
  input: { lifecycleStatus?: TenantProject["lifecycleStatus"] },
  name: string | null,
  productionUrl: string | null,
  testingContext: string | null | undefined,
): Promise<TenantProject> {
  if (productionUrl !== null) {
    await assertProductionUrlAvailable(sql, scopedTeamId, productionUrl, scopedProjectId);
  }
  const rows = await sql<ProjectRow[]>`
    update public.projects
    set name = coalesce(${name}, name),
        production_url = coalesce(${productionUrl}, production_url),
        testing_context = case
          when ${testingContext === undefined} then testing_context
          else ${testingContext ?? null}
        end,
        lifecycle_status = coalesce(${input.lifecycleStatus ?? null}, lifecycle_status),
        updated_at = now()
    where id = ${scopedProjectId} and team_id = ${scopedTeamId}::uuid
    returning ${sql(PROJECT_ROW_COLUMNS)}
  `;
  if (!rows[0]) throw new Error("Project not found.");
  if (productionUrl) {
    const productionOrigin = new URL(productionUrl).origin;
    await sql`
      update public.project_trusted_access
      set status = 'invalid', verified_origin = null, last_verified_at = null,
          updated_by = ${actor.userId}::uuid, updated_at = now()
      where project_id = ${scopedProjectId}
        and team_id = ${scopedTeamId}::uuid
        and status = 'ready'
        and verified_origin is distinct from ${productionOrigin}
    `;
  }
  return mapProject(rows[0]);
}
