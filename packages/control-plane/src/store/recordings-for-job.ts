/**
 * Browser recording metadata under a dispatch lease: one recording per Case
 * Run or Activity (idempotent registration), then a terminal storage
 * transition to available (with playback metadata) or failed.
 */
import { randomUUID } from "node:crypto";

import type postgres from "postgres";
import type { BrowserRecordingPlaybackMetadata } from "@shipbash/contracts/browser-recording-playback";
import type { BrowserRecordingMimeType } from "@shipbash/contracts/database-contract-types";
import type { BrowserRecording, DispatchJobLeaseCapability } from "../types.ts";
import {
	lockDispatchJobCapability,
	requireScopedCaseRun,
} from "./dispatch-capabilities.ts";
import { nonEmpty } from "./normalize.ts";
import { BROWSER_RECORDING_ROW_COLUMNS, type BrowserRecordingRow } from "./rows.ts";
import { mapBrowserRecording } from "./workspace-maps.ts";

export async function registerBrowserRecordingForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  owner: { caseRunId: string },
): Promise<BrowserRecording> {
  return await sql.begin(async (sql) => {
    const job = await lockDispatchJobCapability(sql, capability);
    if (job.kind !== "suite_run") {
      throw new Error("Browser recording requires a Suite Run.");
    }
    const caseRunId = nonEmpty(owner.caseRunId, "caseRunId");
    await requireScopedCaseRun(sql, job, caseRunId);
    const existing = await sql<BrowserRecordingRow[]>`
      select ${sql(BROWSER_RECORDING_ROW_COLUMNS)}
      from public.browser_recordings
      where team_id = ${job.team_id}::uuid
        and project_id = ${job.project_id}
        and case_run_id = ${caseRunId}
      limit 1
      for update
    `;
    if (existing[0]) return mapBrowserRecording(existing[0]);
    const inserted = await sql<BrowserRecordingRow[]>`
      insert into public.browser_recordings (
        id, team_id, project_id, case_run_id
      ) values (
        ${randomUUID()}::uuid, ${job.team_id}::uuid, ${job.project_id},
        ${caseRunId}
      )
      returning ${sql(BROWSER_RECORDING_ROW_COLUMNS)}
    `;
		if (!inserted[0])
			throw new Error("Browser recording metadata could not be registered.");
    return mapBrowserRecording(inserted[0]);
  });
}

/**
 * Locks the recording under the lease and proves its Case Run is the Job's.
 * False when it is already available, an outcome nothing later replaces.
 */
async function lockUnsettledRecording(
  sql: postgres.TransactionSql,
  capability: DispatchJobLeaseCapability,
  recordingId: string,
): Promise<boolean> {
  const job = await lockDispatchJobCapability(sql, capability);
  const recordings = await sql<BrowserRecordingRow[]>`
    select ${sql(BROWSER_RECORDING_ROW_COLUMNS)}
    from public.browser_recordings
    where id = ${recordingId}::uuid
      and team_id = ${job.team_id}::uuid
      and project_id = ${job.project_id}
    limit 1
    for update
  `;
  const recording = recordings[0];
  if (!recording) throw new Error("Scoped browser recording was not found.");
  if (job.kind !== "suite_run" || !recording.case_run_id) {
    throw new Error("Browser recording owner is invalid.");
  }
  await requireScopedCaseRun(sql, job, recording.case_run_id);
  return recording.storage_status !== "available";
}

export async function markBrowserRecordingAvailableForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  recordingId: string,
  input: {
    objectPath: string;
    posterObjectPath: string | null;
		mimeType: BrowserRecordingMimeType;
    sizeBytes: number;
    width: number;
    height: number;
    durationMs: number;
    playback: BrowserRecordingPlaybackMetadata;
  },
): Promise<void> {
  const scopedRecordingId = nonEmpty(recordingId, "recordingId");
  if (
		!Number.isSafeInteger(input.sizeBytes) ||
		input.sizeBytes < 1 ||
		!Number.isSafeInteger(input.width) ||
		input.width < 1 ||
		!Number.isSafeInteger(input.height) ||
		input.height < 1 ||
		!Number.isSafeInteger(input.durationMs) ||
		input.durationMs < 1
  ) {
    throw new Error("Browser recording metadata is invalid.");
  }
  await sql.begin(async (sql) => {
    if (!(await lockUnsettledRecording(sql, capability, scopedRecordingId))) return;
    await sql`
      update public.browser_recordings
      set object_path = ${nonEmpty(input.objectPath, "objectPath")},
          poster_object_path = ${input.posterObjectPath}, mime_type = ${input.mimeType},
          size_bytes = ${input.sizeBytes}, width = ${input.width}, height = ${input.height},
          duration_ms = ${input.durationMs},
          playback_metadata = ${sql.json(input.playback)},
          storage_status = 'available', storage_error = null
      where id = ${scopedRecordingId}::uuid
    `;
  });
}

export async function markBrowserRecordingFailedForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  recordingId: string,
  reason: string,
): Promise<void> {
  const scopedRecordingId = nonEmpty(recordingId, "recordingId");
  const normalizedReason = nonEmpty(reason, "reason").slice(0, 1_000);
  await sql.begin(async (sql) => {
    if (!(await lockUnsettledRecording(sql, capability, scopedRecordingId))) return;
    await sql`
      update public.browser_recordings
      set storage_status = 'failed', storage_error = ${normalizedReason}
      where id = ${scopedRecordingId}::uuid
    `;
  });
}
