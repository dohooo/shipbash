/**
 * Terminalizing a Suite Run's evidence trail: the never-walked Journeys get
 * their own honest terminal Case Runs, cancellation settles every live Case,
 * and evidence finalization either records success or leaves a durable
 * run_finalization_failed warning. Callers own authorization: these run
 * inside a lease-scoped transaction opened by the tenant-store facade.
 */
import type { SuiteRunStatus } from "@shipbash/contracts/database-contract-types";
import type { JsonObject } from "@shipbash/contracts/json";
import type postgres from "postgres";

import type { RunnerRunEvent } from "../types.ts";
import { jobSuiteRunId } from "./dispatch-capabilities.ts";
import { generatedTextId } from "./normalize.ts";
import type { DispatchJobRow } from "./rows.ts";
import { endSuiteRun } from "./run-ending.ts";
import { appendRunEventTransaction } from "./run-events.ts";
import { reportToParentConversation } from "./conversation-reports.ts";
import { enqueueSlackAlert } from "./slack-alert-outbox.ts";

/**
 * The checklist a Case Run keeps when it ends without walking further, as a
 * SET fragment: every pending item is not_run, an item in progress is blocked
 * with the reason, and the verdicts already reported stay. Terminal rows may
 * hold no pending or in-progress item (the checklist CHECK), and a Case Run
 * parked as queued by a claim or a resume still carries a live checklist.
 */
export function settledChecklist(sql: postgres.TransactionSql, reason: string) {
  return sql`case when checklist = '[]'::jsonb then checklist else (
    select jsonb_agg(
      case entry.item ->> 'status'
        when 'pending' then entry.item || '{"status":"not_run","reason":null}'::jsonb
        when 'in_progress' then entry.item || jsonb_build_object('status', 'blocked', 'reason', ${reason}::text)
        else entry.item
      end
      order by entry.ordinal
    )
    from jsonb_array_elements(checklist) with ordinality as entry(item, ordinal)
  ) end`;
}

/** What a Case Run written for a Case the walk never reached says, in the words of its role. */
function missingCaseSummary(role: string, verdict: "error" | "canceled" | "not_run", notRunCause?: string): string {
  if (verdict === "not_run" && notRunCause) return role === "journey"
    ? `This journey was not walked: ${notRunCause}`
    : `This hook was not run: ${notRunCause}`;
  if (role !== "journey") {
    return verdict === "canceled"
      ? "This hook was not run: the run was canceled first."
      : verdict === "not_run"
        ? "This hook was not run: the walk it serves never reached it."
        : "This hook was not run because the Suite execution stopped unexpectedly.";
  }
  return verdict === "canceled"
    ? "This journey was not walked: the run was canceled first."
    : verdict === "not_run"
      ? "This journey was not walked: the run stopped before reaching it."
      : "Case was not run because the Suite execution stopped unexpectedly.";
}

/**
 * Terminalizes the Journeys a stopped Suite Run never walked. They carry
 * their own verdict and their own sentence: inheriting the failing Case's
 * reason reported a journey nobody ran as a second confirmed failure.
 */
export async function createMissingTerminalCaseRuns(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
  verdict: "error" | "canceled" | "not_run",
  reason: string,
  notRunCause?: string,
): Promise<void> {
  const missing = await sql<Array<{ id: string; position: number; attempt: number; role: string }>>`
    select snapshot_case.id, snapshot_case.position, snapshot_case.role,
      coalesce((
        select max(previous.attempt)
        from public.case_runs previous
        where previous.snapshot_case_id = snapshot_case.id
          and previous.team_id = run.team_id
      ), 0)::integer + 1 as attempt
    from public.suite_runs run
    join public.suite_snapshot_cases snapshot_case
      on snapshot_case.snapshot_id = run.suite_snapshot_id
     and snapshot_case.team_id = run.team_id
    left join public.case_runs case_run
      on case_run.suite_run_id = run.id
     and case_run.snapshot_case_id = snapshot_case.id
     and case_run.team_id = run.team_id
    where run.id = ${job.suite_run_id}
      and run.team_id = ${job.team_id}::uuid
      and run.project_id = ${job.project_id}
      and run.mode = 'suite'
      and case_run.id is null
    order by snapshot_case.position
    for share of run, snapshot_case
  `;
  for (const snapshotCase of missing) {
    await sql`
      insert into public.case_runs (
        id, suite_run_id, snapshot_case_id, team_id, position,
        attempt, role, status, verdict, checklist, summary, failure_reason, completed_at
      ) values (
        ${generatedTextId("case_run")}, ${job.suite_run_id}, ${snapshotCase.id},
        ${job.team_id}::uuid, ${snapshotCase.position}, ${snapshotCase.attempt}, ${snapshotCase.role},
        ${verdict === "canceled" ? "canceled" : "completed"}, ${verdict}, '[]'::jsonb,
        ${missingCaseSummary(snapshotCase.role, verdict, notRunCause)},
        ${verdict === "not_run" ? null : reason}, now()
      )
      on conflict (suite_run_id, position, attempt) do nothing
    `;
  }
}

/**
 * Ends a Suite Run whose Job will never report: the Journeys it never reached
 * read as not walked, the one it was walking ends with the verdict and the
 * reason, and the Run completes with them. True when the Run was still in one
 * of runStatuses; the Job row itself is the caller's to settle.
 */
export async function endStrandedSuiteRun(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
  reason: string,
  verdict: "error" | "blocked",
  runStatuses: readonly SuiteRunStatus[] = ["queued", "running", "waiting_for_auth"],
): Promise<boolean> {
  // A checklist item's reason is capped at 300 characters by the schema;
  // an unbounded runner message would fail the write and take the whole
  // finalization down with it.
  const checklistReason = reason.slice(0, 300);
  await createMissingTerminalCaseRuns(sql, job, "not_run", reason);
  // A Case Run still sitting in 'queued' never started walking (or was
  // parked there by a claim or a resume before the walk reached it again),
  // so the run's failure says nothing about it.
  await sql`
    update public.case_runs
    set status = 'completed', verdict = 'not_run',
        summary = 'This journey was not walked: the run stopped before reaching it.',
        failure_reason = null, completed_at = now(),
        checklist = ${settledChecklist(sql, checklistReason)}
    where suite_run_id = ${job.suite_run_id}
      and team_id = ${job.team_id}::uuid
      and status = 'queued'
  `;
  await sql`
    update public.case_runs
    set status = 'completed', verdict = ${verdict}, summary = ${reason},
        failure_reason = ${reason}, completed_at = now(),
        checklist = ${settledChecklist(sql, checklistReason)}
    where suite_run_id = ${job.suite_run_id}
      and team_id = ${job.team_id}::uuid
      and status in ('running', 'waiting_for_auth')
  `;
  await finalizeRunEvidence(sql, job);
  const ended = await endSuiteRun(sql, {
    teamId: job.team_id, projectId: job.project_id, runId: jobSuiteRunId(job),
    status: "completed", verdict, failureReason: reason, from: runStatuses,
  });
  return ended !== null;
}

export async function cancelSuiteRunTransaction(sql: postgres.TransactionSql, job: DispatchJobRow, reason: string): Promise<boolean> {
  await createMissingTerminalCaseRuns(sql, job, "canceled", reason);
  await sql`
    update public.case_runs
    set status = 'canceled', verdict = 'canceled',
        failure_reason = ${reason}, completed_at = now(),
        checklist = ${settledChecklist(sql, reason)}
    where suite_run_id = ${job.suite_run_id} and team_id = ${job.team_id}::uuid
      and status in ('queued', 'running', 'waiting_for_auth')
  `;
  const finalizationFailed = await finalizeRunEvidence(sql, job);
  const canceled = await endSuiteRun(sql, {
    teamId: job.team_id, projectId: job.project_id, runId: jobSuiteRunId(job),
    status: "canceled", verdict: "canceled", failureReason: reason,
    from: ["queued", "running", "waiting_for_auth", "canceling"],
  });
  if (!canceled) throw new Error("Active scoped Suite Run not found.");
  return finalizationFailed;
}

interface RunFinalization {
  finalization_status: string;
}

/** The Run's finalization state, its row locked for the rest of the transaction. */
async function lockRunFinalization(sql: postgres.TransactionSql, job: DispatchJobRow): Promise<RunFinalization> {
  const runs = await sql<RunFinalization[]>`
    select finalization_status
    from public.suite_runs
    where id = ${job.suite_run_id}
      and team_id = ${job.team_id}::uuid
      and project_id = ${job.project_id}
    for update
  `;
  const run = runs[0];
  if (!run) throw new Error("Scoped Suite Run not found.");
  return run;
}

/** Writes the finalization outcome as the Run's next event and settles its status. */
async function settleFinalization(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
  status: "failed" | "finalized",
  event: { type: string; level: RunnerRunEvent["level"]; message: string; data: JsonObject | null },
): Promise<void> {
  await appendRunEventTransaction(sql, {
    teamId: job.team_id, projectId: job.project_id, suiteRunId: jobSuiteRunId(job), ...event,
  });
  await sql`
    update public.suite_runs
    set finalization_status = ${status}
    where id = ${job.suite_run_id} and team_id = ${job.team_id}::uuid
  `;
}

export async function recordRunFinalizationFailure(sql: postgres.TransactionSql, job: DispatchJobRow): Promise<boolean> {
  const run = await lockRunFinalization(sql, job);
  await sql`
    update public.artifacts artifact
    set storage_status = 'failed',
        storage_error = coalesce(storage_error, 'Evidence finalization did not complete.')
    from public.case_runs case_run
    where artifact.case_run_id = case_run.id
      and case_run.suite_run_id = ${job.suite_run_id}
      and artifact.team_id = ${job.team_id}::uuid
      and artifact.project_id = ${job.project_id}
      and artifact.storage_status in ('pending', 'missing')
  `;
  await sql`
    update public.browser_recordings recording
    set storage_status = 'failed',
        storage_error = coalesce(storage_error, 'Evidence finalization did not complete.')
    from public.case_runs case_run
    where recording.case_run_id = case_run.id
      and case_run.suite_run_id = ${job.suite_run_id}
      and recording.team_id = ${job.team_id}::uuid
      and recording.project_id = ${job.project_id}
      and recording.storage_status = 'pending'
  `;
  if (run.finalization_status === "failed") return true;
  await settleFinalization(sql, job, "failed", {
    type: "run_finalization_failed",
    level: "warning",
    message: "Test results were retained, but some final evidence could not be archived.",
    data: { recoveryAction: "Review the available evidence or rerun the Suite." },
  });
  return true;
}

export async function finalizeRunEvidence(sql: postgres.TransactionSql, job: DispatchJobRow): Promise<boolean> {
  // The one place a run's evidence settles, and so the one place its alert is
  // enqueued and its end reported to the conversation that started it, if
  // one did — every completion path reaches here. No Slack: whether a message
  // ever lands must not decide whether the run completes.
  await enqueueSlackAlert(sql, job);
  if (job.suite_run_id) await reportToParentConversation(sql, { suiteRunId: job.suite_run_id });
  const pending = await sql`
    select 1
    from public.artifacts artifact
    join public.case_runs case_run on case_run.id = artifact.case_run_id
    where case_run.suite_run_id = ${job.suite_run_id}
      and artifact.team_id = ${job.team_id}::uuid
      and artifact.project_id = ${job.project_id}
      and artifact.storage_status not in ('available', 'failed')
    limit 1
  `;
  if (pending[0]) return recordRunFinalizationFailure(sql, job);
  const pendingRecording = await sql`
    select 1 from public.browser_recordings recording
    join public.case_runs case_run on case_run.id = recording.case_run_id
    where case_run.suite_run_id = ${job.suite_run_id}
      and recording.team_id = ${job.team_id}::uuid
      and recording.project_id = ${job.project_id}
      and recording.storage_status = 'pending'
    limit 1
  `;
  if (pendingRecording[0]) return recordRunFinalizationFailure(sql, job);
  const run = await lockRunFinalization(sql, job);
  if (run.finalization_status === "failed") return true;
  if (run.finalization_status === "finalized") return false;
  await settleFinalization(sql, job, "finalized", {
    type: "run_finalized",
    level: "success",
    message: "Run results and retained evidence were finalized.",
    data: null,
  });
  return false;
}
