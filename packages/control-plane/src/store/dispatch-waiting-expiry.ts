/**
 * The expired-waiting sweep of the reconciler family: a Suite run parked on
 * waiting_for_auth whose Job's dispatch window (expires_at) lapsed can never
 * resume — resumeSuiteRunAfterAuth refuses an expired Job — and no other
 * reclaim covered status='waiting', so the run could sit "waiting for
 * sign-in" forever. The sweep settles each side honestly: the run and its live Cases
 * end blocked (a sign-in wall nobody answered is an environment block,
 * never a product failure), never-walked Journeys end not_run, an Activity
 * goes to needs_attention, and the Job fails with the reason in the
 * owner's words.
 */
import type postgres from "postgres";

import { SIGN_IN_WINDOW_EXPIRED_REASON } from "../sign-in-window.ts";
import { completeJobActivity } from "./activity-completion.ts";
import { assertDispatchWriteScope, assertSweepLimit, releasedLease } from "./dispatch-capabilities.ts";
import { endStrandedSuiteRun } from "./run-finalization.ts";
import { DISPATCH_JOB_ROW_COLUMNS, type DispatchJobRow } from "./rows.ts";

export async function reconcileExpiredWaitingDispatchJobs(
  sql: postgres.Sql,
  limit = 100,
): Promise<number> {
  assertSweepLimit(limit, "Expired waiting Dispatch limit");
  const reason = SIGN_IN_WINDOW_EXPIRED_REASON;
  return await sql.begin(async (sql) => {
    await sql.unsafe("set local statement_timeout = '10s'");
    const jobs = await sql<DispatchJobRow[]>`
      select ${sql(DISPATCH_JOB_ROW_COLUMNS.map((column) => `job.${column}`))}
      from public.dispatch_jobs job
      where job.status = 'waiting'
        and job.expires_at <= clock_timestamp()
      order by job.created_at, job.id
      limit ${limit}
      for update of job skip locked
    `;
    for (const job of jobs) {
      assertDispatchWriteScope(job);
      if (job.kind === "activity") {
        await completeJobActivity(sql, job, {
          status: "needs_attention",
          resultKind: "needs_attention",
          summary: reason,
          recoveryAction: "Start the exploration again and complete the sign-in when asked.",
          proposalIds: [],
        });
      } else {
        await endStrandedSuiteRun(sql, job, reason, "blocked");
      }
      await sql`
        update public.dispatch_jobs
        set status = 'failed', ${releasedLease(sql)},
            failure_reason = ${reason}, completed_at = now()
        where id = ${job.id}::uuid and status = 'waiting'
      `;
    }
    return jobs.length;
  });
}
