/**
 * Project creation: URL-only, advisory-locked and idempotent per creator +
 * client key. The tenant-store facade owns actor scoping and the Team admin
 * check. A project's repository is bound afterwards, in Settings › GitHub.
 */
import type postgres from "postgres";

import type { AgentRuntime } from "@shipbash/contracts/model-contract";
import { assertProductionUrlAvailable } from "./production-url.ts";
import { PROJECT_ROW_COLUMNS, type ProjectRow } from "./rows.ts";
import { mapProject } from "./workspace-maps.ts";
import type { TenantActor, TenantProject } from "../types.ts";
import { expectRow } from "./expect-row.ts";

/**
 * Holds every other request of this creator's with this key until this
 * transaction ends, so two of them cannot both find nothing and both create.
 */
async function lockClientKey(
  sql: postgres.TransactionSql,
  scopedTeamId: string,
  userId: string,
  clientKey: string,
): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`${scopedTeamId}:${userId}:${clientKey}`}, 0)
    )
  `;
}

/** The Project this creator's request with this key already created, if any. */
async function projectCreatedWithKey(
  sql: postgres.TransactionSql,
  scopedTeamId: string,
  userId: string,
  clientKey: string,
): Promise<TenantProject | null> {
  const rows = await sql<ProjectRow[]>`
    select ${sql(PROJECT_ROW_COLUMNS)} from public.projects
    where team_id = ${scopedTeamId}::uuid
      and created_by = ${userId}::uuid
      and client_idempotency_key = ${clientKey}
  `;
  return rows[0] ? mapProject(rows[0]) : null;
}

export async function createUrlProject(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  scopedTeamId: string,
  input: {
    projectId: string;
    name: string;
    productionUrl: string;
    agentRuntime: AgentRuntime;
    clientKey: string;
  },
): Promise<TenantProject> {
  const { projectId, name, productionUrl, agentRuntime, clientKey } = input;
  await lockClientKey(sql, scopedTeamId, actor.userId, clientKey);
  const created = await projectCreatedWithKey(sql, scopedTeamId, actor.userId, clientKey);
  // A key names one request. Answered for another URL, it would hand the
  // reader a Project they did not ask for.
  if (created && created.productionUrl !== productionUrl) {
    throw new Error("clientIdempotencyKey already created a Project for another Production URL.");
  }
  if (created) return created;
  await assertProductionUrlAvailable(sql, scopedTeamId, productionUrl);
  const rows = await sql<ProjectRow[]>`
    insert into public.projects (
      id, team_id, name, agent_runtime, production_url,
      testing_context, created_by, lifecycle_status, client_idempotency_key
    ) values (
      ${projectId}, ${scopedTeamId}::uuid, ${name}, ${agentRuntime},
      ${productionUrl}, null, ${actor.userId}::uuid, 'active', ${clientKey}
    )
    returning ${sql(PROJECT_ROW_COLUMNS)}
  `;
  return mapProject(expectRow(rows, "projects", "insert"));
}
