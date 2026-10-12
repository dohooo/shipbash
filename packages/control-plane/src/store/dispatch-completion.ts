/**
 * Terminal dispatch job settlement: completion computes the Run verdict from
 * its Journeys' terminal Case Runs (a journey nobody walked can never make a
 * run "passed"; a hook's verdict is its own and never the run's), failure
 * terminalizes every Case honestly, and cancellation settles through the
 * shared cancel transaction. All three release the lease via the
 * compare-and-set transition.
 */
import type { SuiteRunStatus } from "@shipbash/contracts/database-contract-types";
import type postgres from "postgres";

import { completeJobActivity } from "./activity-completion.ts";
import { jobSuiteRunId, lockDispatchJobCapability, normalizeJobReason, transitionLeasedJob } from "./dispatch-capabilities.ts";
import {
  cancelSuiteRunTransaction,
  createMissingTerminalCaseRuns,
  endStrandedSuiteRun,
  finalizeRunEvidence,
} from "./run-finalization.ts";
import { endSuiteRun } from "./run-ending.ts";
import { runVerdict, type RunVerdictTally } from "../run-verdict.ts";
import type { DispatchJobLeaseCapability } from "../types.ts";

type RunCaseCounts = RunVerdictTally & {
  mode: "suite" | "case_retry"; expected: number; total: number; terminal: number; walked: number;
  journeys: number;
};

/**
 * Every attempt written is terminal (a hook walks once per Journey it
 * serves, each walk its own attempt); a suite run holds every snapshot Case,
 * a case retry its one preselected Journey plus the hooks that walked
 * around it.
 */
function runIsSettled(count: RunCaseCounts | undefined): count is RunCaseCounts {
  return count !== undefined
    && count.total > 0
    && count.total === count.terminal
    && count.journeys >= 1
    && (count.mode === "case_retry" ? count.journeys === 1 : count.walked === count.expected);
}

export async function completeDispatchJob(sql: postgres.Sql, capability: DispatchJobLeaseCapability, hookFailureReason?: string): Promise<boolean> {
  return await sql.begin(async (sql) => {
    const job = await lockDispatchJobCapability(sql, capability);
    if (job.kind === "activity") {
      throw new Error("Activities must be completed with completeActivityForJob.");
    }
    // A hook the walk never reached (its setup stopped earlier, or the
    // run's own setup did) is written down as not run, so the report says so
    // instead of leaving the row queued inside a completed run.
    await createMissingTerminalCaseRuns(sql, job, "not_run", "The walk never reached this Case.", hookFailureReason);
    const counts = await sql<RunCaseCounts[]>`
      select run.mode,
        (
          select count(*)::integer from public.suite_snapshot_cases snapshot_case
          where snapshot_case.snapshot_id = run.suite_snapshot_id
            and snapshot_case.team_id = run.team_id
        ) as expected,
        count(case_run.*)::integer as total,
        count(case_run.*) filter (where case_run.status in ('completed', 'canceled'))::integer as terminal,
        count(distinct case_run.snapshot_case_id)::integer as walked,
        count(distinct case_run.snapshot_case_id) filter (where snapshot_case.role = 'journey')::integer as journeys,
        count(case_run.*) filter (where snapshot_case.role = 'journey' and case_run.verdict = 'error')::integer as errors,
        count(case_run.*) filter (where snapshot_case.role = 'journey' and case_run.verdict = 'failed')::integer as failed,
        count(case_run.*) filter (where snapshot_case.role = 'journey' and case_run.verdict = 'blocked')::integer as blocked,
        count(case_run.*) filter (where snapshot_case.role = 'journey' and case_run.verdict = 'canceled')::integer as canceled,
        count(case_run.*) filter (where snapshot_case.role = 'journey' and case_run.verdict = 'not_run')::integer as not_run,
        count(case_run.*) filter (where snapshot_case.role <> 'journey' and case_run.verdict in ('failed', 'blocked', 'error'))::integer as "hookFailures"
      from public.suite_runs run
      left join public.case_runs case_run
        on case_run.suite_run_id = run.id and case_run.team_id = run.team_id
      left join public.suite_snapshot_cases snapshot_case
        on snapshot_case.id = case_run.snapshot_case_id and snapshot_case.team_id = run.team_id
      where run.id = ${job.suite_run_id} and run.team_id = ${job.team_id}::uuid
      group by run.id, run.mode, run.suite_snapshot_id, run.team_id
    `;
    const count = counts[0];
    if (!runIsSettled(count)) {
      throw new Error("Suite Run cannot complete before all Case Runs are terminal.");
    }
    const verdict = runVerdict(count);
    const finalizationFailed = await finalizeRunEvidence(sql, job);
    const completed = await endSuiteRun(sql, {
      teamId: job.team_id, projectId: job.project_id, runId: jobSuiteRunId(job),
      status: verdict === "canceled" ? "canceled" : "completed", verdict, from: ["running", "queued"],
    });
    if (!completed) throw new Error("Active scoped Suite Run not found.");
    await transitionLeasedJob(
      sql,
      job,
      capability,
      finalizationFailed ? "failed" : "completed",
      finalizationFailed ? "Evidence finalization failed after test execution." : null,
    );
    return finalizationFailed;
  });
}

export async function failDispatchJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  reason: string,
): Promise<void> {
  const normalizedReason = normalizeJobReason(reason);
  await sql.begin(async (sql) => {
    const job = await lockDispatchJobCapability(sql, capability);
    if (job.kind === "activity") {
      await completeJobActivity(sql, job, {
        status: "failed",
        resultKind: "failed",
        summary: normalizedReason,
        proposalIds: [],
      });
      await transitionLeasedJob(sql, job, capability, "failed", normalizedReason);
      return;
    }
    const runStatuses: SuiteRunStatus[] = ["queued", "running", "waiting_for_auth", "canceling"];
    if (!(await endStrandedSuiteRun(sql, job, normalizedReason, "error", runStatuses))) {
      throw new Error("Active scoped Suite Run not found.");
    }
    await transitionLeasedJob(sql, job, capability, "failed", normalizedReason);
  });
}

export async function cancelDispatchJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  reason = "Canceled by worker.",
): Promise<void> {
  const normalizedReason = normalizeJobReason(reason);
  await sql.begin(async (sql) => {
    const job = await lockDispatchJobCapability(sql, capability);
    if (job.kind === "activity") {
      await completeJobActivity(sql, job, {
        status: "failed",
        resultKind: "canceled",
        summary: normalizedReason,
        proposalIds: [],
      }, true);
      await transitionLeasedJob(sql, job, capability, "canceled", normalizedReason);
      return;
    }
    const finalizationFailed = await cancelSuiteRunTransaction(sql, job, normalizedReason);
    await transitionLeasedJob(
      sql,
      job,
      capability,
      finalizationFailed ? "failed" : "canceled",
      finalizationFailed ? "Evidence finalization failed after cancellation." : normalizedReason,
    );
  });
}
