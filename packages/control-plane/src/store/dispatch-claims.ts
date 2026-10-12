/**
 * Claiming and holding a dispatch job lease: the compare-and-set claim that
 * flips the job (and its Run or Activity) to running, and the cancellation
 * poll a worker makes before its leg starts (the running leg's heartbeat
 * renews and polls in one statement: dispatch-heartbeat.ts).
 */
import { randomUUID } from "node:crypto";

import type postgres from "postgres";

import { WRAP_UP_GRACE_SECONDS } from "./activity-wrap-up.ts";
import {
  assertDispatchWriteScope,
  lockDispatchJobCapability,
  mapClaimedDispatchJob,
} from "./dispatch-capabilities.ts";
import { nonEmpty, sha256 } from "./normalize.ts";
import {
  TRANSIENT_RETRY_PENDING_PREFIX,
  VERCEL_WORKFLOW_DISPATCH_PENDING_PREFIX,
} from "./rows.ts";
import { DISPATCH_JOB_ROW_COLUMNS, type DispatchJobRow, type SuiteRunRow } from "./rows.ts";
import type { ClaimedDispatchJob, DispatchJobLeaseCapability, JobScope } from "../types.ts";

/**
 * What a claim starts besides the lease: the Job's Suite Run or Activity
 * turns running. Run once per claimed execution, inside the claim.
 */
async function startClaimedWork(sql: postgres.TransactionSql, job: DispatchJobRow): Promise<void> {
  if (job.kind === "suite_run") {
    const targets = await sql<Array<{ status: SuiteRunRow["status"] }>>`
      update public.suite_runs
      set status = case when status = 'canceling' then status else 'running' end,
          started_at = coalesce(started_at, now())
      where id = ${job.suite_run_id}
        and team_id = ${job.team_id}::uuid
        and project_id = ${job.project_id}
        and status in ('queued', 'running', 'canceling')
      returning status
    `;
    // A case retry's preselected Case Run stays queued until the runner
    // starts it (startCaseRunForJob): the hooks around the Journey run
    // first, and one Case Run is active per run at a time.
    if (!targets[0]) throw new Error("Dispatch Job target Suite Run is not claimable.");
    // A claim starts a fresh execution, and the walk starts over from the
    // first Journey. The Journey a dead execution was walking when its
    // lease expired is parked as queued, as a resume parks a waiting one:
    // it holds no place in the one-active Journey index while the fresh
    // attempts ahead of it start, and the walk reuses its row on reaching it.
    await sql`
      update public.case_runs
      set status = 'queued'
      where suite_run_id = ${job.suite_run_id}
        and team_id = ${job.team_id}::uuid
        and status = 'running'
    `;
  } else {
    const targets = await sql`
      update public.activities
      set status = 'running', started_at = coalesce(started_at, now()), updated_at = now()
      where id = ${job.activity_id}::uuid
        and team_id = ${job.team_id}::uuid
        and project_id = ${job.project_id}
        and status in ('queued', 'running')
      returning id
    `;
    if (!targets[0]) throw new Error("Dispatch Job target Activity is not claimable.");
  }
}

export async function claimDispatchJob(
  sql: postgres.Sql,
  jobId: string,
  identityHash: string,
  workerId: string,
  leaseSeconds = 120,
): Promise<ClaimedDispatchJob | null> {
  const scopedJobId = nonEmpty(jobId, "jobId");
  const normalizedHash = sha256(identityHash, "identityHash");
  const normalizedWorkerId = nonEmpty(workerId, "workerId");
  if (normalizedWorkerId.length > 200) throw new Error("workerId exceeds 200 characters.");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 3_600) {
    throw new Error("leaseSeconds must be an integer between 15 and 3600.");
  }
  const leaseToken = randomUUID();
  return await sql.begin(async (sql) => {
    await sql.unsafe("set local statement_timeout = '10s'");
    const rows = await sql<DispatchJobRow[]>`
      update public.dispatch_jobs
      set status = 'leased', lease_token = ${leaseToken}::uuid,
          lease_owner = ${normalizedWorkerId},
          lease_expires_at = clock_timestamp() + (${leaseSeconds} * interval '1 second'),
          leased_at = clock_timestamp(), heartbeat_at = clock_timestamp(),
          failure_reason = null
      where id = ${scopedJobId}::uuid
        and identity_hash = ${normalizedHash}
        and expires_at > clock_timestamp()
        and (
          status = 'queued'
          or (status = 'leased' and lease_expires_at <= clock_timestamp())
          or (status = 'leased' and failure_reason like ${`${TRANSIENT_RETRY_PENDING_PREFIX}%`})
          or (status = 'leased' and failure_reason like ${`${VERCEL_WORKFLOW_DISPATCH_PENDING_PREFIX}%`})
        )
      returning ${sql(DISPATCH_JOB_ROW_COLUMNS)}
    `;
    const job = rows[0];
    if (!job) return null;
    assertDispatchWriteScope(job);
    await startClaimedWork(sql, job);
    return mapClaimedDispatchJob(job);
  });
}

/** A Sandbox's lease, whatever the wire asks for: its claim and every heartbeat renew it by this much. */
export const SANDBOX_LEASE_SECONDS = 120;

/**
 * A Sandbox's claim of the reservation it was launched for. The reservation
 * stays the lease token, so the Sandbox's name stays derivable from the row
 * (job-api/identity.ts). The first claim starts the work; the same worker
 * claiming again (a retry whose answer was lost) gets the row back unchanged
 * in substance, and any other worker gets null.
 */
export async function claimReservedDispatchJob(
  sql: postgres.Sql,
  input: { jobId: string; reservation: string; workerId: string },
): Promise<ClaimedDispatchJob | null> {
  const jobId = nonEmpty(input.jobId, "jobId");
  const reservation = nonEmpty(input.reservation, "reservation");
  const workerId = nonEmpty(input.workerId, "workerId");
  if (workerId.length > 200) throw new Error("workerId exceeds 200 characters.");
  return await sql.begin(async (sql) => {
    await sql.unsafe("set local statement_timeout = '10s'");
    const [prior] = await sql<Array<{ pending: boolean }>>`
      select failure_reason is not null as pending
      from public.dispatch_jobs where id = ${jobId}::uuid
      for update
    `;
    const rows = await sql<DispatchJobRow[]>`
      update public.dispatch_jobs
      set lease_owner = ${workerId},
          lease_expires_at = clock_timestamp() + (${SANDBOX_LEASE_SECONDS} * interval '1 second'),
          leased_at = clock_timestamp(), heartbeat_at = clock_timestamp(),
          failure_reason = null
      where id = ${jobId}::uuid
        and status = 'leased'
        and lease_token = ${reservation}::uuid
        and expires_at > clock_timestamp()
        and (
          failure_reason = ${`${VERCEL_WORKFLOW_DISPATCH_PENDING_PREFIX}${reservation}`}
          or (failure_reason is null and lease_owner = ${workerId} and lease_expires_at > clock_timestamp())
        )
      returning ${sql(DISPATCH_JOB_ROW_COLUMNS)}
    `;
    const job = rows[0];
    if (!job) return null;
    assertDispatchWriteScope(job);
    if (prior?.pending) await startClaimedWork(sql, job);
    return mapClaimedDispatchJob(job);
  });
}

/**
 * A Job whose lease is live, as the job API serves a Sandbox's call for it:
 * its scope, the capability its lease grants, and whether the Sandbox has
 * claimed its reservation yet (a reservation is pending until the first
 * claimReservedDispatchJob).
 */
export interface LeasedDispatchJob {
  claimed: boolean;
  capability: DispatchJobLeaseCapability;
  job: JobScope;
}

export async function readLeasedDispatchJob(sql: postgres.Sql, jobId: string): Promise<LeasedDispatchJob | null> {
  const rows = await sql<Array<{
    id: string;
    kind: "suite_run" | "activity";
    team_id: string;
    project_id: string;
    activity_id: string | null;
    suite_run_id: string | null;
    identity_hash: string;
    lease_token: string;
    lease_owner: string;
    claimed: boolean;
  }>>`
    select id, kind, team_id, project_id, activity_id, suite_run_id, identity_hash, lease_token, lease_owner,
      failure_reason is distinct from ${VERCEL_WORKFLOW_DISPATCH_PENDING_PREFIX} || lease_token::text as claimed
    from public.dispatch_jobs
    where id = ${nonEmpty(jobId, "jobId")}::uuid and status = 'leased'
      and lease_expires_at > clock_timestamp() and expires_at > clock_timestamp()
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    claimed: row.claimed,
    capability: { jobId: row.id, identityHash: row.identity_hash, workerId: row.lease_owner, leaseToken: row.lease_token },
    job: {
      id: row.id,
      kind: row.kind,
      teamId: row.team_id,
      projectId: row.project_id,
      activityId: row.activity_id,
      suiteRunId: row.suite_run_id,
    },
  };
}

export async function isDispatchCancellationRequested(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
): Promise<boolean> {
  return await sql.begin(async (sql) => {
    const job = await lockDispatchJobCapability(sql, capability, false);
    if (job.kind === "suite_run") {
      const rows = await sql<Array<{ canceling: boolean }>>`
        select status = 'canceling' as canceling
        from public.suite_runs
        where id = ${job.suite_run_id} and team_id = ${job.team_id}::uuid
          and project_id = ${job.project_id}
      `;
      return rows[0]?.canceling === true;
    }
    // A wrap-up the leg has not honoured within its grace is the same
    // answer as a cancel: the worker aborts the leg and settles the Job
    // through the one cancel path (store/activity-wrap-up.ts).
    const rows = await sql<Array<{ canceled: boolean }>>`
      select status = 'canceled'
        or wrap_up_requested_at < clock_timestamp() - ${WRAP_UP_GRACE_SECONDS}::int * interval '1 second'
        as canceled
      from public.activities
      where id = ${job.activity_id}::uuid and team_id = ${job.team_id}::uuid
        and project_id = ${job.project_id}
    `;
    return rows[0]?.canceled === true;
  });
}
