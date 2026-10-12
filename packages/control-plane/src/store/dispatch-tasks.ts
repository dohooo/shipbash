/**
 * The launcher's view of the queue: listing claimable dispatch jobs, and the
 * Vercel workflow reservation handshake that pre-leases a job to a remote
 * workflow (and releases the reservation if the workflow never started).
 * Capability rules stay in dispatch-capabilities; callers pass the store's
 * root sql handle.
 */
import type postgres from "postgres";

import { HOST_KINDS } from "@shipbash/contracts/runtime/discovery-surface.mjs";
import { assertSweepLimit, releasedLease } from "./dispatch-capabilities.ts";
import { nonEmpty } from "./normalize.ts";
import { VERCEL_WORKFLOW_DISPATCH_PENDING_PREFIX } from "./rows.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** Whether the job's Activity, joined as `activity`, is a conversation's turn the host runs (HOST_KINDS). */
export function hostTurn(sql: Queryable): postgres.Fragment {
  return sql`coalesce(activity.kind = any(${[...HOST_KINDS]}::text[]), false)`;
}

/** A Job a launcher may claim. */
export interface ClaimableDispatchTask {
  jobId: string;
  identityHash: string;
  kind: "suite_run" | "activity";
  teamId: string;
  projectId: string;
  /** A conversation's turn, run on the host (discovery-surface.mjs HOST_KINDS) rather than in a Sandbox. */
  host: boolean;
}

/** A Job pre-leased to a remote workflow under its reservation. */
export interface VercelDispatchReservation {
  jobId: string;
  identityHash: string;
  kind: "suite_run" | "activity";
  projectId: string;
  reservationId: string;
  /** A conversation's turn: its workflow runs it on the host, never in a Sandbox. */
  host: boolean;
}

/**
 * Whether the job, named `job` by the enclosing query, may take its project's
 * Sandbox slot now: no other Activity holds it, and it is the oldest queued
 * one waiting for it. One leased Activity per project protects the project's
 * browser state. A conversation's turn runs on the host and touches none, so
 * it neither takes the slot nor waits for it: the judgement hostTurn makes,
 * written here against the `held` and `waiting` joins.
 */
function mayTakeProjectSlot(sql: postgres.Sql): postgres.Fragment {
  const host = [...HOST_KINDS];
  return sql`
    not exists (
      select 1 from public.dispatch_jobs active
      join public.activities held on held.id = active.activity_id
      where active.project_id = job.project_id
        and active.kind = 'activity'
        and active.status = 'leased'
        and held.kind <> all(${host}::text[])
    )
    and job.id = (
      select pending.id from public.dispatch_jobs pending
      join public.activities waiting on waiting.id = pending.activity_id
      where pending.project_id = job.project_id
        and pending.kind = 'activity'
        and pending.status = 'queued'
        and pending.expires_at > clock_timestamp()
        and waiting.kind <> all(${host}::text[])
      order by pending.created_at, pending.id
      limit 1
    )
  `;
}

export async function listDispatchTasks(sql: postgres.Sql, limit = 100): Promise<ClaimableDispatchTask[]> {
  assertSweepLimit(limit, "Dispatch task limit");
  const rows = await sql<Array<{
    id: string;
    identity_hash: string;
    kind: "suite_run" | "activity";
    team_id: string;
    project_id: string;
    host: boolean;
  }>>`
    select job.id, job.identity_hash, job.kind, job.team_id, job.project_id, ${hostTurn(sql)} as host
    from public.dispatch_jobs job
    left join public.activities activity on activity.id = job.activity_id
    where job.expires_at > clock_timestamp()
      and (
        job.status = 'queued'
        or (job.status = 'leased' and job.lease_expires_at <= clock_timestamp())
      )
    order by case when job.kind = 'suite_run' then 0 else 1 end, job.created_at, job.id
    limit ${limit}
  `;
  return rows.map((row) => ({
    jobId: row.id,
    identityHash: row.identity_hash,
    kind: row.kind,
    teamId: row.team_id,
    projectId: row.project_id,
    host: row.host,
  }));
}

export async function reserveVercelDispatchTasks(sql: postgres.Sql, limit = 100): Promise<VercelDispatchReservation[]> {
  assertSweepLimit(limit, "Dispatch task limit");
  const rows = await sql<Array<{
    id: string;
    identity_hash: string;
    kind: "suite_run" | "activity";
    project_id: string;
    reservation_id: string;
    host: boolean;
  }>>`
    with candidates as materialized (
      select job.id, gen_random_uuid() as reservation_id, ${hostTurn(sql)} as host
      from public.dispatch_jobs job
      left join public.activities activity on activity.id = job.activity_id
      where job.expires_at > clock_timestamp()
        and job.status = 'queued'
        and (
          job.kind = 'suite_run'
          or ${hostTurn(sql)}
          or (${mayTakeProjectSlot(sql)})
        )
      order by case when job.kind = 'suite_run' then 0 else 1 end, job.created_at, job.id
      limit ${limit}
      for update of job skip locked
    )
    update public.dispatch_jobs job
    set status = 'leased',
        lease_token = candidates.reservation_id,
        lease_owner = 'vercel-workflow:' || candidates.reservation_id::text,
        lease_expires_at = clock_timestamp() + interval '30 minutes',
        leased_at = clock_timestamp(), heartbeat_at = clock_timestamp(),
        failure_reason = ${VERCEL_WORKFLOW_DISPATCH_PENDING_PREFIX}
          || candidates.reservation_id::text
    from candidates
    where job.id = candidates.id
    returning job.id, job.identity_hash, job.kind, job.project_id,
      candidates.reservation_id::text as reservation_id, candidates.host
  `;
  return rows.map((row) => ({
    jobId: row.id,
    identityHash: row.identity_hash,
    kind: row.kind,
    projectId: row.project_id,
    reservationId: row.reservation_id,
    host: row.host,
  }));
}

export async function releaseVercelDispatchReservation(
  sql: postgres.Sql,
  jobId: string,
  reservationId: string,
): Promise<boolean> {
  const scopedJobId = nonEmpty(jobId, "jobId");
  const scopedReservationId = nonEmpty(reservationId, "reservationId");
  const rows = await sql`
    update public.dispatch_jobs
    set status = 'queued', ${releasedLease(sql)},
        failure_reason = null
    where id = ${scopedJobId}::uuid
      and status = 'leased'
      and lease_token = ${scopedReservationId}::uuid
      and lease_owner = ${`vercel-workflow:${scopedReservationId}`}
      and failure_reason = ${`${VERCEL_WORKFLOW_DISPATCH_PENDING_PREFIX}${scopedReservationId}`}
    returning id
  `;
  return rows.length === 1;
}
