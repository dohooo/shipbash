/**
 * Suite reads for the Console: the list, the per-suite summary rollup
 * (active case count + latest run), and the full detail view with per-Case
 * verification state and recent results. Authorization is embedded in every
 * query via the actor's team membership join; the tenant-store facade opens
 * the actor-scoped transaction.
 */
import type postgres from "postgres";

import { latestCaseRun } from "./latest-case-run.ts";
import { iso } from "./normalize.ts";
import type { ScheduleRow, SuiteCaseRow, SuiteRow, Timestamp } from "./rows.ts";
import { mapSchedule, mapSuite, mapSuiteCase } from "./suite-maps.ts";
import type {
  CaseVerdict,
  RunVerdict,
  SuiteCaseDetail,
  SuiteDetail,
  SuiteSummary,
  TenantActor,
} from "../types.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

type SuiteSummaryRow = SuiteRow & {
  active_case_count: number;
  latest_verdict: RunVerdict | null;
  latest_run_at: Timestamp | null;
};

/**
 * A Suite row with its summary rollup — the active Journey count and the
 * latest run — reached through the reader's Team membership. The caller adds
 * its own where clause.
 */
function suiteSummaryFrom(sql: Queryable): postgres.Fragment {
  return sql`
    select suite.id, suite.team_id, suite.project_id, suite.name,
      suite.definition_revision, suite.lifecycle_status, suite.product_thesis, suite.created_by,
      suite.created_at, suite.updated_at,
      (select count(*)::integer from public.suite_cases suite_case
        where suite_case.suite_id = suite.id and suite_case.enabled = true
          and suite_case.archived_at is null and suite_case.role = 'journey') as active_case_count,
      latest.verdict as latest_verdict,
      coalesce(latest.completed_at, latest.started_at, latest.created_at) as latest_run_at
    from public.team_memberships membership
    join public.suites suite on suite.team_id = membership.team_id
    left join lateral (
      select run.verdict, run.completed_at, run.started_at, run.created_at
      from public.suite_runs run
      where run.suite_id = suite.id and run.team_id = suite.team_id
      order by run.created_at desc, run.id desc limit 1
    ) latest on true
  `;
}

export async function listSuiteSummaries(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
): Promise<SuiteSummary[]> {
  const rows = await sql<SuiteSummaryRow[]>`
    ${suiteSummaryFrom(sql)}
    where membership.team_id = ${scopedTeamId}::uuid
      and membership.user_id = ${actor.userId}::uuid
      and suite.project_id = ${scopedProjectId}
    order by suite.updated_at desc, suite.id
  `;
  return rows.map((row) => ({
    ...mapSuite(row),
    activeCaseCount: row.active_case_count,
    latestVerdict: row.latest_verdict,
    latestRunAt: iso(row.latest_run_at, "suite.latest_run_at"),
  }));
}

type SuiteDetailCaseRow = SuiteCaseRow & {
  latest_verdict: CaseVerdict | null;
  latest_run_at: Timestamp | null;
  latest_case_revision: number | null;
  recent_results: Array<{ runId: string; caseRunId: string; isPublic: boolean; verdict: CaseVerdict | null; runAt: string; durationMs: number | null }>;
};

/** The suite's own summary rollup (active case count + latest run), scoped to the actor. */
async function loadSuiteDetailSummary(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedSuiteId: string,
): Promise<SuiteSummaryRow | undefined> {
  const summaries = await sql<SuiteSummaryRow[]>`
    ${suiteSummaryFrom(sql)}
    where membership.team_id = ${scopedTeamId}::uuid
      and membership.user_id = ${actor.userId}::uuid
      and suite.project_id = ${scopedProjectId}
      and suite.id = ${scopedSuiteId}::uuid
  `;
  return summaries[0];
}

/** Every Case in the suite with its per-Case verification state and recent results. */
async function loadSuiteDetailCaseRows(
  sql: Queryable,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedSuiteId: string,
): Promise<SuiteDetailCaseRow[]> {
  return sql<SuiteDetailCaseRow[]>`
    select suite_case.id, suite_case.team_id, suite_case.project_id,
      suite_case.suite_id, suite_case.position, suite_case.title, suite_case.steps,
      suite_case.category, suite_case.checkpoints,
      suite_case.why_it_matters, suite_case.preconditions,
      suite_case.role, suite_case.scope_case_id, suite_case.repeat,
      suite_case.enabled, suite_case.archived_at, suite_case.origin,
      suite_case.revision, suite_case.created_at, suite_case.updated_at,
      latest.verdict as latest_verdict,
      latest.run_at as latest_run_at,
      latest.suite_case_revision as latest_case_revision,
      coalesce(recent.results, '[]'::jsonb) as recent_results
    from public.suite_cases suite_case
    ${latestCaseRun(sql)}
    left join lateral (
      select jsonb_agg(jsonb_build_object(
        'runId', entry.suite_run_id,
        'isPublic', entry.is_public,
        'caseRunId', entry.case_run_id,
        'verdict', entry.verdict,
        'runAt', entry.run_at,
        'durationMs', entry.duration_ms
      ) order by entry.run_at) as results
      from (
        select case_run.suite_run_id, case_run.id as case_run_id, case_run.verdict,
          coalesce(share.is_public, false) as is_public,
          to_jsonb(coalesce(case_run.completed_at, case_run.created_at)) as run_at,
          (extract(epoch from (case_run.completed_at - case_run.started_at)) * 1000)::bigint as duration_ms
        from public.suite_snapshot_cases snapshot_case
        join public.case_runs case_run on case_run.snapshot_case_id = snapshot_case.id
        join public.suite_runs run on run.id = case_run.suite_run_id
        left join public.suite_run_shares share on share.run_id = run.id and share.team_id = run.team_id
        where snapshot_case.suite_case_id = suite_case.id and run.suite_id = suite_case.suite_id
          and case_run.status in ('completed', 'canceled')
        order by case_run.created_at desc, case_run.id desc limit 7
      ) entry
    ) recent on true
    where suite_case.team_id = ${scopedTeamId}::uuid
      and suite_case.project_id = ${scopedProjectId}
      and suite_case.suite_id = ${scopedSuiteId}::uuid
    order by suite_case.position, suite_case.id
  `;
}

/** The row's Case detail, including its verification state and last results. */
function mapSuiteDetailCase(row: SuiteDetailCaseRow): SuiteCaseDetail {
  return {
    ...mapSuiteCase(row),
    latestVerdict: row.latest_verdict,
    latestRunAt: iso(row.latest_run_at, "suite_case.latest_run_at"),
    // The last verified walk ran an older revision of this script.
    verificationState: row.latest_case_revision !== null
      && row.latest_case_revision < row.revision
      ? "unverified"
      : "verified",
    recentResults: (Array.isArray(row.recent_results) ? row.recent_results : []).map((entry) => ({
      runId: String(entry.runId),
      isPublic: entry.isPublic,
      caseRunId: String(entry.caseRunId),
      verdict: entry.verdict,
      runAt: new Date(String(entry.runAt)).toISOString(),
      durationMs: entry.durationMs === null ? null : Number(entry.durationMs),
    })),
  };
}

export async function getSuiteDetail(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedSuiteId: string,
): Promise<SuiteDetail | null> {
  const suite = await loadSuiteDetailSummary(sql, actor, scopedTeamId, scopedProjectId, scopedSuiteId);
  if (!suite) return null;
  const cases = await loadSuiteDetailCaseRows(sql, scopedTeamId, scopedProjectId, scopedSuiteId);
  const schedules = await sql<ScheduleRow[]>`
    select id, team_id, project_id, suite_id, cadence, local_time::text,
      cron_expression, timezone, next_run_at, last_dispatched_at,
      last_skipped_at, last_skip_reason, updated_at
    from public.suite_schedules
    where team_id = ${scopedTeamId}::uuid and project_id = ${scopedProjectId}
      and suite_id = ${scopedSuiteId}::uuid
  `;
  return {
    suite: {
      ...mapSuite(suite),
      activeCaseCount: suite.active_case_count,
      latestVerdict: suite.latest_verdict,
      latestRunAt: iso(suite.latest_run_at, "suite.latest_run_at"),
    },
    cases: cases.map(mapSuiteDetailCase),
    schedule: schedules[0] ? mapSchedule(schedules[0]) : null,
  };
}
