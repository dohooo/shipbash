/**
 * Evidence trail appends under a dispatch lease: run events take the Run's
 * next sequence under its row lock; an activity event proves the lease,
 * takes the Activity's next sequence and lands in one statement, one round
 * trip, because every event the runner emits comes through here from a
 * sandbox a region away and its cost is the evidence stream's throughput.
 */
import type postgres from "postgres";

import { jobSuiteRunId, lockDispatchJobCapability, lockSuiteRunJob, requireScopedCaseRun } from "./dispatch-capabilities.ts";
import { nonEmpty, safeJsonObject, sha256 } from "./normalize.ts";
import type { ActivityEventRow, DispatchJobRow } from "./rows.ts";
import { appendRunEventTransaction } from "./run-events.ts";
import { mapActivityEvent } from "./workspace-maps.ts";
import type {
  ActivityEvent,
  DispatchJobLeaseCapability,
  RunnerRunEvent,
} from "../types.ts";
import type { AppendActivityEventForJobInput, AppendRunEventForJobInput } from "./job-store-inputs.ts";

/** One run event, appended under a Suite Run Job's lease the caller already holds locked. */
export async function appendLockedRunEvent(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
  input: AppendRunEventForJobInput,
): Promise<RunnerRunEvent> {
  const caseRunId = input.caseRunId?.trim() || null;
  const type = nonEmpty(input.type, "type");
  const message = nonEmpty(input.message, "message");
  if (type.length > 200) throw new Error("type exceeds 200 characters.");
  if (message.length > 4_000) throw new Error("message exceeds 4000 characters.");
  if (caseRunId) await requireScopedCaseRun(sql, job, caseRunId);
  return appendRunEventTransaction(sql, {
    teamId: job.team_id,
    projectId: job.project_id,
    suiteRunId: jobSuiteRunId(job),
    caseRunId,
    type,
    level: input.level ?? "info",
    message,
    data: input.data ?? null,
  });
}

export async function appendRunEventForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  input: AppendRunEventForJobInput,
): Promise<RunnerRunEvent> {
  return await sql.begin(async (sql) => appendLockedRunEvent(sql, await lockSuiteRunJob(sql, capability), input));
}

/**
 * A batch of run events in one transaction: the lease is locked once and the
 * batch lands whole or not at all. What a Sandbox's write-behind queue
 * flushes (job-api/remote.ts).
 */
export async function appendRunEventsForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  events: readonly AppendRunEventForJobInput[],
): Promise<void> {
  if (events.length === 0) return;
  await sql.begin(async (sql) => {
    const job = await lockSuiteRunJob(sql, capability);
    for (const input of events) await appendLockedRunEvent(sql, job, input);
  });
}

export async function appendActivityEventForJob(
  sql: postgres.Sql | postgres.TransactionSql,
  capability: DispatchJobLeaseCapability,
  input: AppendActivityEventForJobInput,
): Promise<ActivityEvent> {
  const label = nonEmpty(input.label, "label");
  const safeData = safeJsonObject(input.safeData, "safeData") ?? {};
  // The lease predicate and the write-scope assertion of
  // lockDispatchJobCapability, in the statement: the Activity's next
  // sequence is taken under its row lock, so a concurrent append from the
  // API (activity-transactions.ts) and this one never share a number.
  const rows = await sql<ActivityEventRow[]>`
    with job as (
      select activity_id, team_id, project_id
      from public.dispatch_jobs
      where id = ${nonEmpty(capability.jobId, "capability.jobId")}::uuid
        and identity_hash = ${sha256(capability.identityHash, "capability.identityHash")}
        and status = 'leased'
        and lease_owner = ${nonEmpty(capability.workerId, "capability.workerId")}
        and lease_token = ${nonEmpty(capability.leaseToken, "capability.leaseToken")}::uuid
        and lease_expires_at > clock_timestamp()
        and expires_at > clock_timestamp()
        and kind = 'activity' and suite_run_id is null
        and write_scope ->> 'teamId' = team_id::text
        and write_scope ->> 'projectId' = project_id
        and write_scope ->> 'activityId' = activity_id::text
    ),
    sequenced as (
      update public.activities activity
      set next_event_sequence = activity.next_event_sequence + 1, updated_at = now()
      from job
      where activity.id = job.activity_id and activity.team_id = job.team_id
        and activity.project_id = job.project_id
      returning activity.id, activity.team_id, activity.project_id,
        activity.next_event_sequence - 1 as sequence
    )
    insert into public.activity_events (
      team_id, project_id, activity_id, sequence, kind, label, body_markdown, safe_data
    )
    select team_id, project_id, id, sequence, ${input.kind}::text, ${label}::text,
      ${input.bodyMarkdown?.trim() || null}::text, ${sql.json(safeData)}
    from sequenced
    returning id, team_id, project_id, activity_id, sequence,
      kind, label, body_markdown, safe_data, created_at
  `;
  const row = rows[0];
  if (!row) throw new Error("Dispatch Job lease is invalid, expired, or already released.");
  return mapActivityEvent(row);
}

/** A batch of Activity events in one transaction, under the lease held for the whole batch. */
export async function appendActivityEventsForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  events: readonly AppendActivityEventForJobInput[],
): Promise<void> {
  if (events.length === 0) return;
  await sql.begin(async (sql) => {
    await lockDispatchJobCapability(sql, capability, false);
    for (const input of events) await appendActivityEventForJob(sql, capability, input);
  });
}
