/**
 * The message an Activity's leg missed as it closed. A leg settles its job —
 * completed, failed, or parked waiting for a sign-in — and a steer recorded
 * while it was closing was deferred by the runner rather than folded, so the
 * settlement owes it the bell a steer sent after it would have rung.
 */
import type postgres from "postgres";
import type { DispatchJobLeaseCapability } from "../types.ts";
import { scopedActivity, undeliveredSteers, wakeForSteer } from "./activities.ts";
import { requireActivityId, transitionLeasedJob } from "./dispatch-capabilities.ts";
import type { DispatchJobRow } from "./rows.ts";

export function legScope(job: DispatchJobRow): { teamId: string; projectId: string; activityId: string } {
  return { teamId: job.team_id, projectId: job.project_id, activityId: requireActivityId(job) };
}

/**
 * The oldest message the leg missed as it closed: the runner deferred it
 * (steer_deferred is not a fold), or the leg returned before a heartbeat
 * wrote it into the mount. Only a message recorded since this leg was leased
 * counts: an earlier one was the leg's to open with, and a leg that ended
 * before its agent started (a sign-in refused at the gate) would otherwise
 * wake itself forever. An aside wakes nothing (activity-interaction.ts), so
 * it is never missed. Read before the lease is released, which clears
 * leased_at.
 */
export async function missedSteer(sql: postgres.TransactionSql, job: DispatchJobRow): Promise<string | null> {
  // created_at is the steer transaction's now() (its start), leased_at the
  // claim's clock_timestamp(): a steer begun before the claim and committed
  // after it reads as earlier, and a Sandbox leg's prepare or heartbeat
  // delivers it. A conversation's turn on the host reads no heartbeat files,
  // so one that also missed its opening waits for the next wake
  // (conversation-turn/runtime.ts).
  const rows = await sql<Array<{ client_key: string }>>`
    with activity as (${scopedActivity(sql, legScope(job))}), steers as (${undeliveredSteers(sql)})
    select client_key from steers
    where body_markdown is not null
      and origin is distinct from 'aside'
      and created_at >= (select leased_at from public.dispatch_jobs where id = ${job.id}::uuid)
    order by created_at, sequence
    limit 1
  `;
  return rows[0]?.client_key ?? null;
}

/**
 * Settles the leg's job, then rings the bell for the message it missed, since
 * the wake revives that same job. Whether the message moves the Activity is
 * the guard every message meets (wakeForSteer): a conversing kind now asleep
 * wakes, a run parked on a sign-in resumes. The caller has moved the Activity
 * row, the row a steer's append locks, so a message recorded before the leg
 * ended is found here and one recorded after it moves the Activity itself:
 * one bell either way.
 */
export async function transitionLegOwingMissedSteer(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
  capability: DispatchJobLeaseCapability,
  status: "waiting" | "completed" | "failed",
  failureReason: string | null,
): Promise<void> {
  const missed = await missedSteer(sql, job);
  await transitionLeasedJob(sql, job, capability, status, failureReason);
  if (missed) await wakeForSteer(sql, legScope(job), missed);
}
