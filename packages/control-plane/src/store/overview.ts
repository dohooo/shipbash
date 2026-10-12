/**
 * The Console overview rollup in one membership-scoped read: enabled test
 * count, run count, the unbroken passing streak over completed runs, and
 * the latest runs. The tenant-store facade owns actor scoping.
 */
import type postgres from "postgres";

import type { SuiteRunRow } from "./rows.ts";
import { mapSuiteRun } from "./suite-maps.ts";
import type { OverviewAggregate, TenantActor } from "../types.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

export async function getOverviewAggregate(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
): Promise<OverviewAggregate> {
  const metrics = await sql<Array<{
    project_count: number | string;
    test_count: number | string;
    run_count: number | string;
    passing_streak: number | string;
  }>>`
    with authorized_project as (
      select project.id, project.team_id
      from public.team_memberships membership
      join public.projects project on project.team_id = membership.team_id
      where membership.team_id = ${scopedTeamId}::uuid
        and membership.user_id = ${actor.userId}::uuid
        and project.id = ${scopedProjectId}
    ), ordered_runs as (
      select run.verdict,
        sum(case when run.verdict <> 'passed' then 1 else 0 end)
          over (order by run.created_at desc, run.id desc rows unbounded preceding) as breaks
      from public.suite_runs run
      join authorized_project project
        on project.id = run.project_id and project.team_id = run.team_id
      where run.status = 'completed'
    )
    select
      (select count(*) from authorized_project) as project_count,
      (select count(*) from public.suite_cases suite_case
        join authorized_project project
          on project.id = suite_case.project_id and project.team_id = suite_case.team_id
        where suite_case.enabled = true and suite_case.archived_at is null) as test_count,
      (select count(*) from public.suite_runs run
        join authorized_project project
          on project.id = run.project_id and project.team_id = run.team_id) as run_count,
      (select count(*) from ordered_runs
        where verdict = 'passed' and breaks = 0) as passing_streak
  `;
  if (!metrics[0] || Number(metrics[0].project_count) !== 1) {
    throw new Error("Project not found.");
  }
  const recentRows = await sql<SuiteRunRow[]>`
    select run.id, run.team_id, run.project_id, run.suite_id, run.suite_snapshot_id,
      run.source_suite_run_id,
      run.status, run.verdict, run.finalization_status, run.trigger_kind,
      run.created_at, run.started_at, run.completed_at
    from public.team_memberships membership
    join public.suite_runs run on run.team_id = membership.team_id
    where membership.team_id = ${scopedTeamId}::uuid
      and membership.user_id = ${actor.userId}::uuid
      and run.project_id = ${scopedProjectId}
    order by run.created_at desc, run.id desc
    limit 7
  `;
  return {
    testCount: Number(metrics[0].test_count),
    runCount: Number(metrics[0].run_count),
    passingStreak: Number(metrics[0].passing_streak),
    latestRuns: recentRows.slice(0, 6).map((row) => mapSuiteRun(row)),
    hasMoreRuns: recentRows.length > 6,
  };
}
