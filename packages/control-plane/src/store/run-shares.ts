import { randomBytes } from "node:crypto";
import type postgres from "postgres";

import { publicId } from "./public-run-store.ts";

export interface SuiteRunShare {
  isPublic: boolean;
  token: string | null;
  /** Each snapshot Case's id on the shared page; empty without a link. */
  caseIds: Record<string, string>;
}

type ShareRow = { is_public: boolean | null; token: string | null; case_ids: string[] };

export async function getSuiteRunShare(
  sql: postgres.TransactionSql,
  teamId: string,
  projectId: string,
  runId: string,
): Promise<SuiteRunShare | null> {
  const rows = await sql<ShareRow[]>`
    select share.is_public, share.token,
      array(
        select snapshot_case.id from public.suite_snapshot_cases snapshot_case
        where snapshot_case.snapshot_id = run.suite_snapshot_id and snapshot_case.team_id = run.team_id
      ) as case_ids
    from public.suite_runs run
    left join public.suite_run_shares share
      on share.run_id = run.id and share.team_id = run.team_id
    where run.id = ${runId} and run.team_id = ${teamId}::uuid
      and run.project_id = ${projectId}
  `;
  const row = rows[0];
  if (!row) return null;
  const { token } = row;
  return {
    isPublic: row.is_public ?? false,
    token,
    caseIds: token ? Object.fromEntries(row.case_ids.map((id) => [id, publicId(token, id)])) : {},
  };
}

export async function setSuiteRunShare(
  sql: postgres.TransactionSql,
  teamId: string,
  projectId: string,
  runId: string,
  isPublic: boolean,
  sharedByUserId: string,
): Promise<SuiteRunShare | null> {
  // The run lock serializes concurrent enables before either request reads the
  // share row. Re-enabling an already public run preserves its current token.
  const runs = await sql`
    select id from public.suite_runs
    where id = ${runId} and team_id = ${teamId}::uuid
      and project_id = ${projectId}
    for update
  `;
  if (!runs[0]) return null;
  const current = await getSuiteRunShare(sql, teamId, projectId, runId);
  if (current?.isPublic === isPublic) return current;
  const token = isPublic ? randomBytes(32).toString("base64url") : null;
  const profiles = isPublic ? await sql<{ display_name: string }[]>`
    select display_name from public.user_profiles where user_id = ${sharedByUserId}::uuid
  ` : [];
  const name = profiles[0]?.display_name.trim() ?? null;
  // A profile may use an email as its display name; never publish that as provenance.
  const sharedBy = name && !name.includes("@") ? name : null;
  await sql`
    insert into public.suite_run_shares (run_id, team_id, is_public, token, shared_by_display_name)
    values (${runId}, ${teamId}::uuid, ${isPublic}, ${token}, ${sharedBy})
    on conflict (run_id) do update
      set is_public = excluded.is_public,
          token = excluded.token,
          shared_by_display_name = excluded.shared_by_display_name,
          updated_at = now()
  `;
  return getSuiteRunShare(sql, teamId, projectId, runId);
}
