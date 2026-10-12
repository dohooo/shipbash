/**
 * Suite Run list reads and the owner-facing run lifecycle: cancellation
 * (leased jobs keep their lease until the worker's heartbeat observes it;
 * unleased jobs and their Case Runs settle immediately with honest
 * checklists) and the waiting-for-auth resume, by hand or once the Project's
 * way in for runs is ready. The tenant-store facade owns actor scoping and
 * the Project role checks.
 */
import type postgres from "postgres";

import { nonEmpty } from "./normalize.ts";
import { appendRunEventTransaction } from "./run-events.ts";
import { endSuiteRun } from "./run-ending.ts";
import { SUITE_RUN_ROW_COLUMNS, type SuiteRunRow } from "./rows.ts";
import { mapSuiteRun } from "./suite-maps.ts";
import type { SuiteRunSummary, TenantActor } from "../types.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

export async function listSuiteRuns(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedLimit: number,
): Promise<SuiteRunSummary[]> {
  const rows = await sql<SuiteRunRow[]>`
    select run.id, run.team_id, run.project_id, run.suite_id, run.suite_snapshot_id,
      run.source_suite_run_id,
      run.status, run.verdict, run.finalization_status, run.trigger_kind,
      run.created_at, run.started_at, run.completed_at,
      coalesce(share.is_public, false) as is_public
    from public.team_memberships membership
    join public.suite_runs run on run.team_id = membership.team_id
    left join public.suite_run_shares share on share.run_id = run.id and share.team_id = run.team_id
    where membership.team_id = ${scopedTeamId}::uuid
      and membership.user_id = ${nonEmpty(actor.userId, "actor.userId")}::uuid
      and run.project_id = ${scopedProjectId}
    order by run.created_at desc, run.id
    limit ${scopedLimit}
  `;
  return rows.map(mapSuiteRun);
}

export async function requestSuiteRunCancellation(
  sql: postgres.TransactionSql,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedRunId: string,
): Promise<SuiteRunSummary> {
  const runRows = await sql<SuiteRunRow[]>`
    select ${sql(SUITE_RUN_ROW_COLUMNS)}
    from public.suite_runs
    where id = ${scopedRunId} and team_id = ${scopedTeamId}::uuid
      and project_id = ${scopedProjectId}
    for update
  `;
  const run = runRows[0];
  if (!run) throw new Error("Suite Run not found.");
  if (run.status === "completed" || run.status === "canceled") return mapSuiteRun(run);
  const jobs = await sql<Array<{ id: string; status: string }>>`
    select id, status from public.dispatch_jobs
    where team_id = ${scopedTeamId}::uuid and project_id = ${scopedProjectId}
      and suite_run_id = ${scopedRunId} and kind = 'suite_run'
    for update
  `;
  const job = jobs[0];
  if (!job) throw new Error("Suite Run dispatch Job not found.");
  const scope = { teamId: scopedTeamId, projectId: scopedProjectId, suiteRunId: scopedRunId };
  if (run.status !== "canceling") {
    await appendRunEventTransaction(sql, { ...scope, type: "cancel_requested", level: "warning", message: "Cancellation requested." });
  }
  if (job.status === "leased") {
    const updated = await sql<SuiteRunRow[]>`
      update public.suite_runs
      set status = 'canceling'
      where id = ${scopedRunId} and team_id = ${scopedTeamId}::uuid
        and status in ('queued', 'running', 'waiting_for_auth', 'canceling')
      returning ${sql(SUITE_RUN_ROW_COLUMNS)}
    `;
    if (!updated[0]) throw new Error("Active Suite Run not found.");
    return mapSuiteRun(updated[0]);
  }
  await sql`
    update public.dispatch_jobs
    set status = 'canceled', completed_at = now(), failure_reason = 'Canceled by user.',
        lease_token = null, lease_owner = null, lease_expires_at = null,
        leased_at = null, heartbeat_at = null
    where id = ${job.id}::uuid and status in ('queued', 'waiting')
  `;
  await sql`
    update public.case_runs case_run
    set status = 'canceled', verdict = 'canceled',
        checklist = coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', item ->> 'id',
            'goal', item ->> 'goal',
            'status', case when item ->> 'status' in ('passed', 'failed', 'blocked', 'not_run')
              then item ->> 'status' else 'not_run' end
          ) order by ordinal)
          from jsonb_array_elements(case_run.checklist) with ordinality as value(item, ordinal)
        ), '[]'::jsonb),
        failure_reason = 'Canceled before execution completed.',
        completed_at = now()
    where suite_run_id = ${scopedRunId} and team_id = ${scopedTeamId}::uuid
      and status in ('queued', 'running', 'waiting_for_auth')
  `;
  await appendRunEventTransaction(sql, { ...scope, type: "run_finalized", message: "Run canceled; retained evidence remains available." });
  const canceled = await endSuiteRun(sql, {
    teamId: scopedTeamId, projectId: scopedProjectId, runId: scopedRunId, status: "canceled", verdict: "canceled",
    failureReason: "Canceled by user.", finalized: true, from: ["queued", "running", "waiting_for_auth", "canceling"],
  });
  if (!canceled) throw new Error("Active Suite Run not found.");
  return mapSuiteRun(canceled);
}

/**
 * A run parked on a sign-in, back on the queue with its job. The run is locked
 * before its job, the order cancellation takes them in, so a resume and a
 * cancel of the same run wait for each other instead of deadlocking. False
 * when the run no longer waits or its job is no longer waiting.
 */
export async function resumeSuiteRunAfterAuth(
  sql: postgres.TransactionSql,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedRunId: string,
): Promise<boolean> {
  const runs = await sql<Array<{ id: string }>>`
    select id from public.suite_runs
    where id = ${scopedRunId} and team_id = ${scopedTeamId}::uuid
      and project_id = ${scopedProjectId} and status = 'waiting_for_auth'
    for update
  `;
  if (!runs[0]) return false;
  const jobs = await sql<Array<{ id: string }>>`
    update public.dispatch_jobs
    set status = 'queued', completed_at = null, failure_reason = null
    where team_id = ${scopedTeamId}::uuid and project_id = ${scopedProjectId}
      and suite_run_id = ${scopedRunId} and kind = 'suite_run'
      and status = 'waiting' and expires_at > clock_timestamp()
    returning id
  `;
  if (!jobs[0]) return false;
  await sql`
    update public.suite_runs set status = 'queued'
    where id = ${scopedRunId} and team_id = ${scopedTeamId}::uuid
  `;
  await sql`
    update public.case_runs set status = 'queued'
    where suite_run_id = ${scopedRunId} and team_id = ${scopedTeamId}::uuid
      and status = 'waiting_for_auth'
  `;
  return true;
}

/**
 * Every run of the Team parked on a sign-in whose Project's runs sign in with
 * this way in, put back on the queue now that it is ready: each through the
 * resume "I'm done" uses, with why on its log. A Project that bound this way
 * in without choosing it for its runs, or a way in that is not ready, moves
 * nothing; a run another resume already moved is left alone. Answers the runs
 * it resumed.
 */
export async function resumeRunsWaitingForSignIn(
  sql: postgres.TransactionSql,
  scope: { teamId: string; signInId: string },
): Promise<string[]> {
  const { teamId } = scope;
  const waiting = await sql<Array<{ id: string; project_id: string; label: string | null }>>`
    select run.id, run.project_id, sign_in.label
    from public.suite_runs run
    join public.project_sign_ins binding
      on binding.team_id = run.team_id and binding.project_id = run.project_id
    join public.team_sign_ins sign_in on sign_in.id = binding.sign_in_id and sign_in.team_id = binding.team_id
    where run.team_id = ${teamId}::uuid and binding.sign_in_id = ${scope.signInId}::uuid
      and binding.for_runs and sign_in.status = 'ready' and run.status = 'waiting_for_auth'
    order by run.created_at, run.id
  `;
  const resumed: string[] = [];
  for (const run of waiting) {
    if (!await resumeSuiteRunAfterAuth(sql, teamId, run.project_id, run.id)) continue;
    await appendRunEventTransaction(sql, {
      teamId, projectId: run.project_id, suiteRunId: run.id, type: "auth_resumed",
      message: run.label
        ? `Resumed: the project's sign-in ${run.label} is ready.`
        : "Resumed: the project's sign-in is ready.",
    });
    resumed.push(run.id);
  }
  return resumed;
}
