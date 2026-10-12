/**
 * Dispatch job lifecycle between claim and settlement: parking the job as
 * waiting for auth (a person's wait never rides on a runtime), preparing a
 * transient retry, and recording finalization failure under the lease.
 */
import type postgres from "postgres";

import {
  lockDispatchJobCapability,
  normalizeJobReason,
  requireActivityId,
  transitionLeasedJob,
} from "./dispatch-capabilities.ts";
import { transitionLegOwingMissedSteer } from "./leg-missed-steer.ts";
import { nonEmpty, sha256 } from "./normalize.ts";
import { recordRunFinalizationFailure } from "./run-finalization.ts";
import { reportToParentConversation } from "./conversation-reports.ts";
import { TRANSIENT_RETRY_PENDING_PREFIX } from "./rows.ts";
import type { DispatchJobLeaseCapability } from "../types.ts";

export async function releaseDispatchJobWaitingForAuth(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
): Promise<void> {
  await sql.begin(async (sql) => {
    const job = await lockDispatchJobCapability(sql, capability);
    if (job.kind === "suite_run") {
      const targets = await sql`
        update public.suite_runs set status = 'waiting_for_auth'
        where id = ${job.suite_run_id} and team_id = ${job.team_id}::uuid
          and project_id = ${job.project_id} and status = 'running'
        returning id
      `;
      if (!targets[0]) throw new Error("Running Suite Run not found for auth handoff.");
      await sql`
        update public.case_runs set status = 'waiting_for_auth'
        where suite_run_id = ${job.suite_run_id} and team_id = ${job.team_id}::uuid
          and status = 'running'
      `;
      await transitionLeasedJob(sql, job, capability, "waiting", null);
    } else {
      const targets = await sql`
        update public.activities set status = 'waiting_for_auth', updated_at = now()
        where id = ${job.activity_id}::uuid and team_id = ${job.team_id}::uuid
          and project_id = ${job.project_id} and status = 'running'
        returning id
      `;
      if (!targets[0]) throw new Error("Running Activity not found for auth handoff.");
      // A walk a conversation started reports the sign-in it waits on.
      await reportToParentConversation(sql, { walkActivityId: requireActivityId(job) });
      // A message the leg missed as it parked resumes the run, as one sent after the park does.
      await transitionLegOwingMissedSteer(sql, job, capability, "waiting", null);
    }
  });
}

export async function prepareDispatchJobTransientRetry(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  reason: string,
): Promise<void> {
  const normalizedReason = nonEmpty(reason, "reason").slice(0, 1_900);
  await sql.begin(async (sql) => {
    const job = await lockDispatchJobCapability(sql, capability);
    const rows = await sql`
      update public.dispatch_jobs
      set failure_reason = ${`${TRANSIENT_RETRY_PENDING_PREFIX}${normalizedReason}`}
      where id = ${job.id}::uuid
        and identity_hash = ${sha256(capability.identityHash, "identityHash")}
        and lease_owner = ${nonEmpty(capability.workerId, "workerId")}
        and lease_token = ${nonEmpty(capability.leaseToken, "leaseToken")}::uuid
        and status = 'leased'
      returning id
    `;
    if (!rows[0]) throw new Error("Leased Dispatch Job could not be prepared for retry.");
  });
}

export async function markDispatchFinalizationFailed(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  reason: string,
): Promise<void> {
  // Refused as any Job reason is, though nothing here records it.
  normalizeJobReason(reason);
  await sql.begin(async (sql) => {
    const job = await lockDispatchJobCapability(sql, capability);
    if (job.kind !== "suite_run") {
      throw new Error("Only Suite Runs have artifact finalization state.");
    }
    await recordRunFinalizationFailure(sql, job);
  });
}
