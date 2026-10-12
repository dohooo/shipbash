/**
 * Queue reconcilers: settling dispatch jobs nobody will settle themselves —
 * expired leases on canceling runs, jobs stranded by archived (deleted)
 * projects, and expired remote leases: a Sandbox's terminalize at-most-once
 * instead of replaying, a conversation turn's leave the conversation awake.
 * Each sweep is its own short transaction over the store's root sql handle.
 */
import type postgres from "postgres";

import type { CompleteActivityInput } from "../types.ts";
import { wakeForSteer } from "./activities.ts";
import { completeJobActivity } from "./activity-completion.ts";
import { assertDispatchWriteScope, assertSweepLimit, releasedLease } from "./dispatch-capabilities.ts";
import { reclaimCanceledActivityDispatchJobs } from "./dispatch-leases.ts";
import { hostTurn } from "./dispatch-tasks.ts";
import { legScope, missedSteer } from "./leg-missed-steer.ts";
import { cancelSuiteRunTransaction, endStrandedSuiteRun, settledChecklist } from "./run-finalization.ts";
import { endSuiteRun } from "./run-ending.ts";
import { DISPATCH_JOB_ROW_COLUMNS, type DispatchJobRow } from "./rows.ts";

/** What the record says of a conversation's turn whose host was lost. */
const TURN_LOST = "The conversation's turn stopped before it could answer. The next message picks the conversation up again.";
/** What the owner does when a conversation's turn ended without answering. */
export const TURN_RECOVERY_ACTION = "Send the message again.";

export async function reconcileExpiredDispatchCancellations(sql: postgres.Sql, limit = 100): Promise<number> {
  assertSweepLimit(limit, "Dispatch cancellation limit");
  // A canceled Activity strands its own Job harder than a canceling Run does:
  // the Job stays unclaimable and holds its project's Activity slot forever.
  const activities = await reclaimCanceledActivityDispatchJobs(sql, limit);
  return activities + (await sql.begin(async (sql) => {
    await sql.unsafe("set local statement_timeout = '10s'");
    const jobs = await sql<DispatchJobRow[]>`
      select ${sql(DISPATCH_JOB_ROW_COLUMNS.map((column) => `job.${column}`))}
      from public.dispatch_jobs job
      join public.suite_runs run
        on run.id = job.suite_run_id and run.team_id = job.team_id
      where job.kind = 'suite_run'
        and job.status = 'leased'
        and job.lease_expires_at <= clock_timestamp()
        and run.status = 'canceling'
      order by job.created_at, job.id
      limit ${limit}
      for update of job, run skip locked
    `;
    for (const job of jobs) {
      assertDispatchWriteScope(job);
      const finalizationFailed = await cancelSuiteRunTransaction(
        sql,
        job,
        "Canceled by user.",
      );
      await sql`
        update public.dispatch_jobs
        set status = ${finalizationFailed ? "failed" : "canceled"},
            ${releasedLease(sql)},
            failure_reason = ${finalizationFailed
              ? "Evidence finalization failed after cancellation."
              : "Canceled by user."},
            completed_at = now()
        where id = ${job.id}::uuid and status = 'leased'
      `;
    }
    return jobs.length;
  }));
}

/**
 * A deleted (archived) project's dispatch jobs must reach a terminal state,
 * or they jam the launcher forever: they sort oldest-first, win every
 * concurrency slot on each 30s poll, fail preparation because the project
 * is gone, and starve every newer job — a livelock the user experiences as
 * "my fresh discovery sits Queued". Runs every launcher drain, so stale
 * garbage from replaced dev processes self-heals too. Actively-leased jobs
 * are left alone until their lease expires: a live container may still be
 * finishing an honest teardown.
 */
export async function reconcileArchivedProjectDispatchJobs(sql: postgres.Sql, limit = 100): Promise<number> {
  assertSweepLimit(limit, "Dispatch reconcile limit");
  const reason = "The project was deleted before this work could run.";
  // One transaction: a crash between the job, run, and case statements must
  // never leave a canceled job beside a still-live run.
  return await sql.begin(async (sql) => {
    await sql.unsafe("set local statement_timeout = '10s'");
    const rows = await sql<Array<{ id: string }>>`
      update public.dispatch_jobs job
      set status = 'canceled', ${releasedLease(sql)},
          failure_reason = ${reason},
          completed_at = now()
      from public.projects project
      where project.id = job.project_id
        and project.lifecycle_status = 'archived'
        and job.id in (
          select candidate.id from public.dispatch_jobs candidate
          where candidate.status = 'queued'
            or (candidate.status = 'leased' and candidate.lease_expires_at <= clock_timestamp())
          order by candidate.created_at, candidate.id
          limit ${limit}
        )
      returning job.id
    `;
    // A canceled job must not strand its run in "queued" forever: terminalize
    // any non-terminal run whose job is canceled.
    const canceledRuns = await sql<Array<{ id: string; team_id: string; project_id: string }>>`
      select run.id, job.team_id, job.project_id
      from public.suite_runs run
      join public.dispatch_jobs job on job.suite_run_id = run.id
      where job.status = 'canceled'
        and run.status not in ('completed', 'canceled')
      for update of run
    `;
    for (const run of canceledRuns) {
      await endSuiteRun(sql, {
        teamId: run.team_id, projectId: run.project_id, runId: run.id, status: "canceled", verdict: "canceled",
        from: ["queued", "running", "waiting_for_auth", "canceling"],
      });
    }
    if (canceledRuns.length > 0) {
      // Live checklists terminalize like the other cancel paths: a canceled
      // terminal row may not keep pending/in_progress items (DB CHECK).
      await sql`
        update public.case_runs
        set status = 'canceled', verdict = 'canceled', completed_at = now(),
            checklist = ${settledChecklist(sql, reason)}
        where suite_run_id in ${sql(canceledRuns.map((run) => run.id))}
          and status not in ('completed', 'canceled')
      `;
    }
    return rows.length;
  });
}

/**
 * Production Sandbox work is intentionally at-most-once after its Agent has
 * started. A crashed remote task may already have submitted product data, so
 * an expired lease is terminalized for explicit review instead of silently
 * replaying the same Journey and duplicating side effects.
 *
 * A conversation's turn on the host whose Function died — or whose step threw
 * before its claim, and is never retried — must not end its thread: the
 * conversation ends needing attention, which the next message wakes, and that
 * turn answers what the lost one left owed (its messages are acknowledged only
 * once a turn has answered them). A message that arrived while the lost turn
 * held the conversation found it running and woke nothing, so the sweep rings
 * for it as a turn that ends does (leg-missed-steer.ts): only a message
 * recorded since the claim counts, so a turn that dies every time never wakes
 * itself again.
 */
export async function reconcileExpiredVercelDispatchJobs(sql: postgres.Sql, limit = 100): Promise<number> {
  assertSweepLimit(limit, "Expired remote Dispatch limit");
  const reason = "The remote Runner stopped before it could report a definitive result. Review the target product before rerunning this Journey.";
  return await sql.begin(async (sql) => {
    await sql.unsafe("set local statement_timeout = '10s'");
    const jobs = await sql<Array<DispatchJobRow & { host: boolean }>>`
      select ${sql(DISPATCH_JOB_ROW_COLUMNS.map((column) => `job.${column}`))}, ${hostTurn(sql)} as host
      from public.dispatch_jobs job
      left join public.activities activity on activity.id = job.activity_id
      where job.status = 'leased'
        and job.lease_expires_at <= clock_timestamp()
        and not exists (
          select 1 from public.suite_runs run
          where job.kind = 'suite_run'
            and run.id = job.suite_run_id
            and run.team_id = job.team_id
            and run.status = 'canceling'
        )
      order by job.created_at, job.id
      limit ${limit}
      for update of job skip locked
    `;
    for (const job of jobs) {
      assertDispatchWriteScope(job);
      // A conversation's turn needs attention and leaves the conversation awake; any other work failed.
      const lost: CompleteActivityInput = job.host
        ? { status: "needs_attention", resultKind: "needs_attention", summary: TURN_LOST, recoveryAction: TURN_RECOVERY_ACTION, proposalIds: [] }
        : { status: "failed", resultKind: "failed", summary: reason, proposalIds: [] };
      // Read before the release below clears leased_at.
      const missed = job.host ? await missedSteer(sql, job) : null;
      if (job.kind === "activity") await completeJobActivity(sql, job, lost);
      else await endStrandedSuiteRun(sql, job, reason, "error");
      await sql`
        update public.dispatch_jobs
        set status = 'failed', ${releasedLease(sql)},
            failure_reason = ${lost.summary}, completed_at = now()
        where id = ${job.id}::uuid and status = 'leased'
          and lease_expires_at <= clock_timestamp()
      `;
      if (missed) await wakeForSteer(sql, legScope(job), missed);
    }
    return jobs.length;
  });
}
