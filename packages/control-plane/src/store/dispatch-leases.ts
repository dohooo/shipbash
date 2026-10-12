/**
 * Reclaiming dispatch leases nobody is holding any more.
 *
 * Cancelling work that is already leased is a sentinel, not a settlement: the
 * target row goes terminal and the Job keeps its lease until the worker's
 * heartbeat notices and performs the terminal transition itself. That hand-off
 * only happens while a worker is alive to make it. A Runner container that died
 * — or a service that restarted — never returns control to the loop, so the
 * lease is left to expire with nobody to settle it.
 *
 * For Activities that stranding is self-sustaining rather than merely slow: the
 * queue re-lists an expired lease, `claimDispatchJob` re-leases the row and then
 * fails its "the Activity must be queued or running" guard, and the whole
 * transaction rolls back to `leased`. The Job is unclaimable and unfinishable,
 * and it holds its project's Activity slot against every later Activity forever.
 */
import type postgres from "postgres";

import { assertSweepLimit, releasedLease } from "./dispatch-capabilities.ts";

/**
 * Settles Activity Jobs whose lease has expired and whose Activity the owner
 * already canceled. The Activity is terminal before this runs — cancellation
 * wrote its result and events — so only the Job row is left to close out.
 *
 * Only expired leases are touched. A live lease still belongs to a worker that
 * may be finishing an honest teardown, and that worker settles its own Job.
 */
export async function reclaimCanceledActivityDispatchJobs(
  sql: postgres.Sql,
  limit = 100,
): Promise<number> {
  assertSweepLimit(limit, "Dispatch reclaim limit");
  const rows = await sql<Array<{ id: string }>>`
    update public.dispatch_jobs job
    set status = 'canceled', ${releasedLease(sql)},
        failure_reason = 'Canceled by user.', completed_at = now()
    from public.activities activity
    where activity.id = job.activity_id
      and activity.team_id = job.team_id
      and activity.status = 'canceled'
      and job.id in (
        select candidate.id from public.dispatch_jobs candidate
        where candidate.kind = 'activity'
          and candidate.status = 'leased'
          and candidate.lease_expires_at <= clock_timestamp()
        order by candidate.created_at, candidate.id
        limit ${limit}
      )
    returning job.id
  `;
  return rows.length;
}
