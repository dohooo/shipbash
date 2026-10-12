/**
 * A walk's browser recording, kept the same way in both lanes: the job API
 * registers it and signs its uploads, the task puts the video resumably and
 * its poster, and the server settles it — available once it has found
 * the video and read its metadata, failed otherwise. The recording's
 * announcement names only its id, so the task writes it.
 */
import type { Stats } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  BROWSER_RECORDING_FILE,
  BROWSER_RECORDING_METADATA_FILE,
  BROWSER_RECORDING_POSTER_FILE,
} from "@shipbash/contracts/runtime/browser-recording-format.mjs";

import { uploadBrowserVideo } from "../browser-recording-upload.ts";
import type { SuiteCaseRunReference } from "../dispatch-worker-types.ts";
import { isRecord } from "../is-record.ts";
import type { RecordingSettlement, RecordingTargets, SettledRecording } from "../job-api/methods/storage.ts";
import type { UploadTarget } from "../storage-objects.ts";
import { recordingRetention } from "./announcements.ts";
import { type EvidencePort, failureText, putFile, UploadRefused } from "./transfer.ts";

export interface RetainedRecording {
  /** Null when there was nothing to keep, or it was kept already. */
  recordingId: string | null;
  error: string | null;
}

interface RecordingFiles {
  video: string;
  metadata: string;
  poster: string;
}

const NOTHING: RetainedRecording = { recordingId: null, error: null };

function recordingFiles(directory: string): RecordingFiles {
  return {
    video: join(directory, BROWSER_RECORDING_FILE),
    metadata: join(directory, BROWSER_RECORDING_METADATA_FILE),
    poster: join(directory, BROWSER_RECORDING_POSTER_FILE),
  };
}

async function assertRecordingFilesContained(directory: string, files: RecordingFiles): Promise<void> {
  const root = await realpath(directory);
  for (const path of Object.values(files)) {
    if (!(await stat(path).catch(() => null))) continue;
    const location = relative(root, await realpath(path));
    if (location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location)) {
      throw new Error("Browser recording file escaped its Case output directory.");
    }
  }
}

/**
 * The poster, put when the metadata promised it and its file is there. It is
 * optional: Storage refusing it costs only the poster, while a network that
 * failed every retry fails the recording, as it would have the video.
 */
async function putPoster(target: UploadTarget, metadata: unknown, path: string): Promise<boolean> {
  const promised = isRecord(metadata) && metadata.poster === true;
  if (!promised || !(await stat(path).catch(() => null))?.isFile()) return false;
  try {
    await putFile(target, path);
    return true;
  } catch (error) {
    if (error instanceof UploadRefused) return false;
    throw error;
  }
}

async function uploadRecording(
  targets: RecordingTargets,
  directory: string,
  video: Stats | null,
  metadataFile: Stats | null,
): Promise<RecordingSettlement["outcome"]> {
  const files = recordingFiles(directory);
  await assertRecordingFilesContained(directory, files);
  // Both the video and its metadata sidecar must exist before an upload is attempted.
  if (!video?.isFile() || !metadataFile?.isFile()) throw new Error("Browser recording output is incomplete.");
  if (video.size < 1) throw new Error("Browser recording is empty.");
  const metadata: unknown = JSON.parse(await readFile(files.metadata, "utf8"));
  await uploadBrowserVideo({ videoPath: files.video, sizeBytes: video.size, target: targets.video });
  return { ok: true, metadata, poster: await putPoster(targets.poster, metadata, files.poster) };
}

/** The recording as the server settled it; nothing to announce when it was available already. */
function retained(settled: SettledRecording | null): RetainedRecording {
  return settled ?? NOTHING;
}

/**
 * Keeps one walk's recording, unannounced. `retryFailed`: a recording the
 * runner reported ready may replace an earlier capture failure; the sweep at
 * the end of a run never retries one. `expected`: a ready recording promised
 * output, so files that are not there become an explicit failure. Targets
 * that could not be signed fail this recording, never the run's retention.
 */
export async function keepRecording(
  port: EvidencePort,
  caseRunId: string,
  directory: string,
  options: { retryFailed: boolean; expected: boolean },
): Promise<RetainedRecording> {
  const files = recordingFiles(directory);
  const [video, metadataFile] = await Promise.all([
    stat(files.video).catch(() => null),
    stat(files.metadata).catch(() => null),
  ]);
  if (!video?.isFile() && !metadataFile?.isFile() && !options.expected) return NOTHING;
  let targets: RecordingTargets | null;
  try {
    targets = await port.recordingPrepare(caseRunId);
  } catch (error) {
    return retained(await port.recordingSettle({ caseRunId, uploadId: null, outcome: { ok: false, failure: failureText(error) } }));
  }
  if (!targets || (targets.failed && !options.retryFailed)) return NOTHING;
  const outcome = await uploadRecording(targets, directory, video, metadataFile)
    .catch((error: unknown): RecordingSettlement["outcome"] => ({ ok: false, failure: failureText(error) }));
  return retained(await port.recordingSettle({ caseRunId, uploadId: targets.uploadId, outcome }));
}

/** A registered recording announces itself, whichever way it went. */
export async function announceRecording(port: EvidencePort, caseRunId: string, retained: RetainedRecording): Promise<void> {
  if (!retained.recordingId) return;
  await port.appendRunEventsForJob([recordingRetention(caseRunId, { recordingId: retained.recordingId, error: retained.error })]);
}

/** One walk's browser recording, the runner having reported it ready, from the walk's own output directory. */
export async function retainCaseRecording(port: EvidencePort, reference: SuiteCaseRunReference, directory: string): Promise<void> {
  const kept = await keepRecording(port, reference.caseRunId, directory, { retryFailed: true, expected: true });
  await announceRecording(port, reference.caseRunId, kept);
}

/** A walk whose recording could not be captured: its recording fails, unless one was kept already. */
export async function failCaseRecording(port: EvidencePort, reference: SuiteCaseRunReference, reason: string): Promise<void> {
  await port.recordingSettle({ caseRunId: reference.caseRunId, uploadId: null, outcome: { ok: false, failure: failureText(reason) } });
}
