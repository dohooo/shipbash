/**
 * Dispatch Job lease capability primitives. Every Runner-side write proves a
 * live lease — job id, identity hash, worker, and token, all unexpired —
 * before touching any scoped row, and the job's write scope is re-asserted
 * against the job row itself on every lock. Callers own the transaction:
 * these run inside the caller's lease-scoped write (tenant-store facade).
 */
import type postgres from "postgres";

import { iso, nonEmpty, sha256 } from "./normalize.ts";
import { DISPATCH_JOB_ROW_COLUMNS, type DispatchJobRow, type RunnerCaseRunRow, type Timestamp } from "./rows.ts";
import type {
  ClaimedDispatchJob,
  DispatchJobLeaseCapability,
  RunnerCaseRun,
  RunnerRunEvent,
} from "../types.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** A sweep's batch size, refused outside 1..500 in the sweep's own words. */
export function assertSweepLimit(limit: number, label: string): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error(`${label} must be between 1 and 500.`);
  }
}

/** The reason a worker gives for ending its Job: present, and at most 4000 characters. */
export function normalizeJobReason(reason: string): string {
  const normalizedReason = nonEmpty(reason, "reason");
  if (normalizedReason.length > 4_000) throw new Error("reason exceeds 4000 characters.");
  return normalizedReason;
}

/** The SET assignments that let go of a Job's lease. */
export function releasedLease(sql: Queryable): postgres.Fragment {
  return sql`lease_token = null, lease_owner = null, lease_expires_at = null, leased_at = null, heartbeat_at = null`;
}

export async function lockDispatchJobCapability(
  sql: postgres.TransactionSql,
  capability: DispatchJobLeaseCapability,
  exclusive = true,
): Promise<DispatchJobRow> {
  const jobId = nonEmpty(capability.jobId, "capability.jobId");
  const identityHash = sha256(capability.identityHash, "capability.identityHash");
  const workerId = nonEmpty(capability.workerId, "capability.workerId");
  const leaseToken = nonEmpty(capability.leaseToken, "capability.leaseToken");
  const rows = await sql<DispatchJobRow[]>`
    select ${sql(DISPATCH_JOB_ROW_COLUMNS)}
    from public.dispatch_jobs
    where id = ${jobId}::uuid
      and identity_hash = ${identityHash}
      and status = 'leased'
      and lease_owner = ${workerId}
      and lease_token = ${leaseToken}::uuid
      and lease_expires_at > clock_timestamp()
      and expires_at > clock_timestamp()
    ${exclusive ? sql`for update` : sql`for share`}
  `;
  const job = rows[0];
  if (!job) throw new Error("Dispatch Job lease is invalid, expired, or already released.");
  assertDispatchWriteScope(job);
  return job;
}

/** The lease of a Suite Run's Job, locked; any other Job's lease is refused. */
export async function lockSuiteRunJob(
  sql: postgres.TransactionSql,
  capability: DispatchJobLeaseCapability,
  exclusive = true,
): Promise<DispatchJobRow> {
  const job = await lockDispatchJobCapability(sql, capability, exclusive);
  if (job.kind !== "suite_run") throw new Error("Dispatch Job is not a Suite Run.");
  return job;
}

/** The Suite Run a suite-run Job writes to; its write scope guarantees one. */
export function jobSuiteRunId(job: DispatchJobRow): string {
  if (!job.suite_run_id) throw new Error("Dispatch Job is not a Suite Run.");
  return job.suite_run_id;
}

export function assertDispatchWriteScope(job: DispatchJobRow): void {
  const scope = job.write_scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Error("Dispatch Job write scope is invalid.");
  }
  if (scope.teamId !== job.team_id || scope.projectId !== job.project_id) {
    throw new Error("Dispatch Job write scope does not match its tenant scope.");
  }
  if (job.kind === "suite_run") {
    if (!job.suite_run_id || scope.suiteRunId !== job.suite_run_id || job.activity_id !== null) {
      throw new Error("Dispatch Job Suite Run scope is invalid.");
    }
  } else if (!job.activity_id || scope.activityId !== job.activity_id || job.suite_run_id !== null) {
    throw new Error("Dispatch Job Activity scope is invalid.");
  }
}

/**
 * The Activity an `activity` Dispatch Job settles. Two guarantees already make
 * the id present — the `dispatch_jobs_check` constraint pairs `kind =
 * 'activity'` with a non-null activity_id, and assertDispatchWriteScope rejects
 * the row before any caller sees it — so a missing one is a broken invariant
 * that must name itself rather than reach a transaction as undefined.
 */
export function requireActivityId(job: DispatchJobRow): string {
  if (!job.activity_id) throw new Error("Dispatch Job Activity scope is invalid.");
  return job.activity_id;
}

export async function requireScopedCaseRun(
  sql: Queryable,
  job: DispatchJobRow,
  caseRunId: string,
): Promise<void> {
  const rows = await sql`
    select 1 from public.case_runs
    where id = ${nonEmpty(caseRunId, "caseRunId")}
      and suite_run_id = ${job.suite_run_id}
      and team_id = ${job.team_id}::uuid
  `;
  if (!rows[0]) throw new Error("Case Run is outside the Job write scope.");
}

export async function transitionLeasedJob(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
  capability: DispatchJobLeaseCapability,
  status: "waiting" | "completed" | "failed" | "canceled",
  failureReason: string | null,
): Promise<void> {
  const rows = await sql`
    update public.dispatch_jobs
    set status = ${status}, ${releasedLease(sql)},
        failure_reason = ${failureReason},
        completed_at = case when ${status} = 'waiting' then null else now() end
    where id = ${job.id}::uuid
      and identity_hash = ${sha256(capability.identityHash, "capability.identityHash")}
      and status = 'leased'
      and lease_owner = ${nonEmpty(capability.workerId, "capability.workerId")}
      and lease_token = ${nonEmpty(capability.leaseToken, "capability.leaseToken")}::uuid
      and lease_expires_at > clock_timestamp()
    returning id
  `;
  if (!rows[0]) throw new Error("Dispatch Job lease transition lost its compare-and-set race.");
}

export function mapClaimedDispatchJob(row: DispatchJobRow): ClaimedDispatchJob {
  if (
    row.status !== "leased"
    || !row.lease_token
    || !row.lease_owner
    || !row.lease_expires_at
  ) {
    throw new Error("Dispatch Job is not leased.");
  }
  return {
    id: row.id,
    teamId: row.team_id,
    projectId: row.project_id,
    kind: row.kind,
    suiteRunId: row.suite_run_id,
    activityId: row.activity_id,
    idempotencyKey: row.idempotency_key,
    writeScope: row.write_scope,
    status: row.status,
    expiresAt: iso(row.expires_at, "dispatch_jobs.expires_at"),
    leaseToken: row.lease_token,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: iso(row.lease_expires_at, "dispatch_jobs.lease_expires_at"),
  };
}

export function mapRunnerRunEvent(row: {
  id: string;
  suite_run_id: string;
  case_run_id: string | null;
  sequence: number | string;
  type: string;
  level: RunnerRunEvent["level"];
  message: string;
  data: Record<string, unknown> | null;
  created_at: Timestamp;
}): RunnerRunEvent {
  return {
    id: row.id,
    suiteRunId: row.suite_run_id,
    caseRunId: row.case_run_id,
    sequence: Number(row.sequence),
    type: row.type,
    level: row.level,
    message: row.message,
    data: row.data,
    createdAt: iso(row.created_at, "run_events.created_at"),
  };
}

export function mapRunnerCaseRun(row: RunnerCaseRunRow): RunnerCaseRun {
  return {
    id: row.id,
    suiteRunId: row.suite_run_id,
    snapshotCaseId: row.snapshot_case_id,
    position: row.position,
    attempt: row.attempt,
    status: row.status,
    verdict: row.verdict,
    checklist: row.checklist,
    summary: row.summary,
    failureReason: row.failure_reason,
    trust: {
      reproducedRuns: row.reproduced_runs,
      codeEvidence: row.code_evidence,
    },
    createdAt: iso(row.created_at, "case_runs.created_at"),
    startedAt: iso(row.started_at, "case_runs.started_at"),
    completedAt: iso(row.completed_at, "case_runs.completed_at"),
  };
}
