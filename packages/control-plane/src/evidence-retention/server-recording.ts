/**
 * The server's half of keeping a walk's browser recording (the job API's
 * recordingPrepare and recordingSettle): the recording is registered once
 * per Case Run, each attempt uploads into a folder of its own under the
 * Project's prefix, and a recording turns available only once the server has
 * found its video in Storage and read its metadata.
 */
import { randomUUID } from "node:crypto";

import { BROWSER_RECORDING_MIME_TYPE } from "@shipbash/contracts/runtime/browser-recording-format.mjs";

import {
  BROWSER_RECORDING_FILE_SIZE_LIMIT_BYTES,
  browserRecordingObjectPaths,
  parseBrowserRecordingMetadata,
  type SupabaseBrowserRecordingStorage,
} from "../browser-recording-storage.ts";
import type { JobContext } from "../job-api/define.ts";
import type { RecordingSettlement, RecordingTargets, SettledRecording } from "../job-api/methods/storage.ts";
import { errorMessage, safeText } from "../service/http-input.ts";

/** What the recording methods read of a call's context. */
export type RecordingContext = Pick<JobContext, "store" | "browserRecordingStorage" | "capability" | "job">;

type RecordingPaths = ReturnType<typeof browserRecordingObjectPaths>;

function recordingStorageOf(context: RecordingContext): SupabaseBrowserRecordingStorage {
  if (!context.browserRecordingStorage) throw new Error("Browser recording Storage is unavailable.");
  return context.browserRecordingStorage;
}

function pathsOf(context: RecordingContext, recordingId: string, uploadId: string): RecordingPaths {
  return browserRecordingObjectPaths({ teamId: context.job.teamId, projectId: context.job.projectId, recordingId, uploadId });
}

export async function prepareRecording(context: RecordingContext, caseRunId: string): Promise<RecordingTargets | null> {
  const storage = recordingStorageOf(context);
  const recording = await context.store.jobs.registerBrowserRecordingForJob(context.capability, { caseRunId });
  if (recording.storageStatus === "available") return null;
  const uploadId = randomUUID();
  const targets = await storage.signedUploadTargets(pathsOf(context, recording.id, uploadId));
  return { uploadId, failed: recording.storageStatus === "failed", ...targets };
}

/** The poster's path, when the task put the one the metadata promised (`put`) and it is there. */
async function storedPoster(storage: SupabaseBrowserRecordingStorage, put: boolean, path: string): Promise<string | null> {
  return put && (await storage.objectSize(path)) ? path : null;
}

async function markAvailable(
  context: RecordingContext,
  recordingId: string,
  paths: RecordingPaths,
  outcome: Extract<RecordingSettlement["outcome"], { ok: true }>,
): Promise<void> {
  const storage = recordingStorageOf(context);
  const metadata = parseBrowserRecordingMetadata(outcome.metadata);
  const sizeBytes = await storage.objectSize(paths.video);
  if (!sizeBytes) throw new Error("The browser recording was not stored.");
  if (sizeBytes > BROWSER_RECORDING_FILE_SIZE_LIMIT_BYTES) {
    throw new Error(`Browser recording exceeds the ${String(BROWSER_RECORDING_FILE_SIZE_LIMIT_BYTES)}-byte limit.`);
  }
  const poster = await storedPoster(storage, outcome.poster && metadata.poster, paths.poster);
  await context.store.jobs.markBrowserRecordingAvailableForJob(context.capability, recordingId, {
    objectPath: paths.video,
    posterObjectPath: poster,
    mimeType: BROWSER_RECORDING_MIME_TYPE,
    sizeBytes,
    width: metadata.width,
    height: metadata.height,
    durationMs: metadata.durationMs,
    playback: metadata.playback,
  });
}

/** Null once the recording is available, or why it is not. */
async function availableOrFailure(
  context: RecordingContext,
  recordingId: string,
  paths: RecordingPaths | null,
  outcome: RecordingSettlement["outcome"],
): Promise<string | null> {
  if (!outcome.ok) return outcome.failure;
  if (!paths) return "The browser recording names no upload.";
  try {
    await markAvailable(context, recordingId, paths, outcome);
    return null;
  } catch (error) {
    return safeText(errorMessage(error), 1_000) || "The browser recording could not be kept.";
  }
}

/**
 * The walk's recording, settled: available, or failed with why. The
 * recording is found by its Case Run under the job's own lease before any
 * object is touched, so a settle naming a walk of another run touches
 * nothing; a failed attempt's objects are removed, so only an available
 * recording leaves files behind. Null when it was available already.
 */
export async function settleRecording(context: RecordingContext, settlement: RecordingSettlement): Promise<SettledRecording | null> {
  const recording = await context.store.jobs.registerBrowserRecordingForJob(context.capability, { caseRunId: settlement.caseRunId });
  if (recording.storageStatus === "available") return null;
  const paths = settlement.uploadId ? pathsOf(context, recording.id, settlement.uploadId) : null;
  const failure = await availableOrFailure(context, recording.id, paths, settlement.outcome);
  if (failure === null) return { recordingId: recording.id, error: null };
  if (paths) await context.browserRecordingStorage?.remove([paths.video, paths.poster]).catch(() => undefined);
  await context.store.jobs.markBrowserRecordingFailedForJob(context.capability, recording.id, failure);
  return { recordingId: recording.id, error: failure };
}
