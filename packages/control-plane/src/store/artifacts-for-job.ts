/**
 * Artifact metadata under a dispatch lease: idempotent registration keyed by
 * source path, then exactly one terminal storage transition — available with
 * its object identity, or failed with its reason — settled with the line it
 * leaves on the run's timeline. Every failure leaves evidence; nothing is
 * silently dropped.
 */
import type postgres from "postgres";

import { lockSuiteRunJob, requireScopedCaseRun } from "./dispatch-capabilities.ts";
import { appendLockedRunEvent } from "./job-events.ts";
import { generatedTextId, iso, nonEmpty } from "./normalize.ts";
import type { DispatchJobRow, Timestamp } from "./rows.ts";
import type { DispatchJobLeaseCapability, RunnerArtifact } from "../types.ts";
import type {
  ArtifactSettlementForJob,
  MarkArtifactAvailableForJobInput,
  MarkArtifactFailedForJobInput,
  RegisterArtifactForJobInput,
} from "./job-store-inputs.ts";

/** A Suite artifact's row, registered once per source path under the lease the caller holds locked; the second call answers the first's. */
async function registerLockedArtifact(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
  caseRunId: string,
  input: RegisterArtifactForJobInput,
): Promise<RunnerArtifact> {
  const scopedCaseRunId = nonEmpty(caseRunId, "caseRunId");
  const label = nonEmpty(input.label, "label");
  const localPath = nonEmpty(input.localPath, "localPath");
  if (!(["screenshot", "trace", "console", "timeline", "manifest", "video"] as const).includes(input.kind)) {
    throw new Error("kind is invalid.");
  }
  if (label.length > 500) throw new Error("label exceeds 500 characters.");
  if (localPath.length > 4_096) throw new Error("localPath exceeds 4096 characters.");
  await requireScopedCaseRun(sql, job, scopedCaseRunId);
  const existing = await sql<Array<{
    id: string;
    case_run_id: string;
    kind: RunnerArtifact["kind"];
    label: string;
    mime_type: string | null;
    size_bytes: number | string | null;
    storage_status: RunnerArtifact["storageStatus"];
    created_at: Timestamp;
  }>>`
    select id, case_run_id, kind, label, mime_type, size_bytes,
      storage_status, created_at
    from public.artifacts
    where case_run_id = ${scopedCaseRunId}
      and team_id = ${job.team_id}::uuid
      and project_id = ${job.project_id}
      and source_path = ${localPath}
    order by created_at
    limit 1
    for update
  `;
  let row = existing[0];
  if (!row) {
    const artifactId = generatedTextId("artifact");
    const inserted = await sql<typeof existing>`
      insert into public.artifacts (
        id, case_run_id, kind, object_path, source_path, label,
        storage_status, team_id, project_id
      ) values (
        ${artifactId}, ${scopedCaseRunId}, ${input.kind},
        ${`pending/${artifactId}`}, ${localPath}, ${label},
        'pending', ${job.team_id}::uuid, ${job.project_id}
      )
      returning id, case_run_id, kind, label, mime_type, size_bytes,
        storage_status, created_at
    `;
    row = inserted[0];
  }
  if (!row) throw new Error("Artifact metadata could not be registered.");
  return {
    id: row.id,
    caseRunId: row.case_run_id,
    kind: row.kind,
    label: row.label,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    storageStatus: row.storage_status,
    createdAt: iso(row.created_at, "artifacts.created_at"),
  };
}

export async function registerArtifactForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  caseRunId: string,
  input: RegisterArtifactForJobInput,
): Promise<RunnerArtifact> {
  return await sql.begin(async (sql) => registerLockedArtifact(sql, await lockSuiteRunJob(sql, capability), caseRunId, input));
}

async function markLockedArtifactAvailable(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
  artifactId: string,
  input: MarkArtifactAvailableForJobInput,
): Promise<void> {
  const objectPath = nonEmpty(input.objectPath, "objectPath");
  const mimeType = nonEmpty(input.mimeType, "mimeType");
  if (objectPath.length > 2_048 || mimeType.length > 200) {
    throw new Error("Artifact Storage metadata exceeds its limit.");
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw new Error("sizeBytes must be a non-negative safe integer.");
  }
  if (!/^[0-9a-f]{64}$/u.test(input.sha256)) throw new Error("sha256 is invalid.");
  const rows = await sql`
    update public.artifacts artifact
    set object_path = ${objectPath}, mime_type = ${mimeType},
        size_bytes = ${input.sizeBytes}, sha256 = ${input.sha256},
        storage_status = 'available', storage_error = null
    from public.case_runs case_run
    where artifact.id = ${artifactId}
      and artifact.case_run_id = case_run.id
      and artifact.team_id = ${job.team_id}::uuid
      and artifact.project_id = ${job.project_id}
      and case_run.suite_run_id = ${job.suite_run_id}
      and case_run.team_id = ${job.team_id}::uuid
      and artifact.storage_status in ('pending', 'failed')
    returning artifact.id
  `;
  if (rows[0]) return;
  const existing = await sql`
    select 1
    from public.artifacts artifact
    join public.case_runs case_run on case_run.id = artifact.case_run_id
    where artifact.id = ${artifactId}
      and artifact.team_id = ${job.team_id}::uuid
      and artifact.project_id = ${job.project_id}
      and case_run.suite_run_id = ${job.suite_run_id}
      and artifact.storage_status = 'available'
      and artifact.object_path = ${objectPath}
      and artifact.sha256 = ${input.sha256}
  `;
  if (!existing[0]) throw new Error("Scoped Artifact cannot be finalized as available.");
}

async function markLockedArtifactFailed(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
  artifactId: string,
  input: MarkArtifactFailedForJobInput,
): Promise<void> {
  const reason = nonEmpty(input.reason, "reason");
  const mimeType = nonEmpty(input.mimeType, "mimeType");
  if (reason.length > 1_000 || mimeType.length > 200) {
    throw new Error("Artifact failure metadata exceeds its limit.");
  }
  if (input.sizeBytes !== null && (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0)) {
    throw new Error("sizeBytes must be null or a non-negative safe integer.");
  }
  const rows = await sql`
    update public.artifacts artifact
    set mime_type = ${mimeType}, size_bytes = ${input.sizeBytes},
        storage_status = 'failed', storage_error = ${reason}
    from public.case_runs case_run
    where artifact.id = ${artifactId}
      and artifact.case_run_id = case_run.id
      and artifact.team_id = ${job.team_id}::uuid
      and artifact.project_id = ${job.project_id}
      and case_run.suite_run_id = ${job.suite_run_id}
      and case_run.team_id = ${job.team_id}::uuid
      and artifact.storage_status in ('pending', 'failed')
    returning artifact.id
  `;
  if (rows[0]) return;
  const available = await sql`
    select 1
    from public.artifacts artifact
    join public.case_runs case_run on case_run.id = artifact.case_run_id
    where artifact.id = ${artifactId}
      and artifact.team_id = ${job.team_id}::uuid
      and artifact.project_id = ${job.project_id}
      and case_run.suite_run_id = ${job.suite_run_id}
      and artifact.storage_status = 'available'
  `;
  if (!available[0]) throw new Error("Scoped Artifact cannot be finalized as failed.");
}

/**
 * A batch of Suite artifacts settled in one transaction under one lease
 * lock: each row found or registered by its source path, turned available
 * or failed, and its line put on the run's timeline. The batch lands whole
 * or not at all.
 */
export async function settleArtifactsForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  settlements: readonly ArtifactSettlementForJob[],
): Promise<void> {
  if (settlements.length === 0) return;
  await sql.begin(async (sql) => {
    const job = await lockSuiteRunJob(sql, capability);
    for (const settlement of settlements) {
      const artifact = await registerLockedArtifact(sql, job, settlement.caseRunId, settlement.artifact);
      if ("available" in settlement.outcome) await markLockedArtifactAvailable(sql, job, artifact.id, settlement.outcome.available);
      else await markLockedArtifactFailed(sql, job, artifact.id, settlement.outcome.failed);
      const event = settlement.announce(artifact.id);
      if (event) await appendLockedRunEvent(sql, job, event);
    }
  });
}
