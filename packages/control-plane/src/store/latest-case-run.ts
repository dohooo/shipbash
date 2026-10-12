/**
 * A Case's latest walk, as every reader of a Journey's latest verdict takes
 * it — the console's Journeys (suites.ts) and list_journeys
 * (journeys-for-job.ts) — so both name the same walk: the newest Case Run of
 * the Case in its own Suite's runs, whatever its status.
 */
import type postgres from "postgres";

type Queryable = postgres.Sql | postgres.TransactionSql;

/**
 * `left join lateral … latest`, for the query's `suite_case`: the walk's
 * verdict, when it ran (finished or started), the Case revision it walked,
 * its id, and the run whose page shows it — a retried Case's original run.
 */
export function latestCaseRun(sql: Queryable): postgres.Fragment {
  return sql`left join lateral (
    select case_run.verdict, coalesce(case_run.completed_at, case_run.created_at) as run_at,
      snapshot_case.suite_case_revision, case_run.id as case_run_id,
      case when run.trigger_kind = 'case_retry' and run.source_suite_run_id is not null
        then run.source_suite_run_id else run.id end as page_run_id
    from public.suite_snapshot_cases snapshot_case
    join public.case_runs case_run on case_run.snapshot_case_id = snapshot_case.id
    join public.suite_runs run on run.id = case_run.suite_run_id
    where snapshot_case.suite_case_id = suite_case.id and run.suite_id = suite_case.suite_id
    order by case_run.created_at desc, case_run.id desc limit 1
  ) latest on true`;
}
