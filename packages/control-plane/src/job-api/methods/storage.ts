/**
 * Evidence bytes on signed URLs: the server derives every object path from
 * the job's own scope, signs the upload of that path alone, and once the
 * task has put the bytes checks the object in Storage before it writes the
 * row transition itself. An upload's announcement is written here too, so an
 * event names only a path the server signed; a recording's names no path,
 * and the task writes it (evidence-retention/recording.ts).
 */
import { z } from "zod";

import { prepareEvidenceUploads, settleEvidenceUploads } from "../../evidence-retention/server-uploads.ts";
import { prepareRecording, settleRecording } from "../../evidence-retention/server-recording.ts";
import { MAX_UPLOADS_PER_CALL } from "../../evidence-retention/transfer.ts";
import type { ResumableUploadTarget, UploadTarget } from "../../storage-objects.ts";
import { defineJobMethod } from "../define.ts";

const upload = z.object({
  /** A Case Run of the job's Suite Run, or `review`, `final` or `terminal` for an Activity's evidence. */
  group: z.string().min(1).max(200),
  /** The file's path in the walk; at most what an artifact row keeps (store/artifacts-for-job.ts). */
  sourcePath: z.string().min(1).max(4_096),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  sizeBytes: z.number().int().nonnegative(),
});
const settledUpload = upload.extend({
  /** Why the client could not put the bytes; null when it did. */
  failure: z.string().min(1).max(1_000).nullable(),
});
const recordingSettlement = z.object({
  /** The walk whose recording is settled: the server finds its recording under the job's own lease. */
  caseRunId: z.string().min(1).max(200),
  /** The attempt's upload the targets were signed for; null when nothing was uploaded. */
  uploadId: z.uuid().nullable(),
  outcome: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), metadata: z.unknown(), poster: z.boolean() }),
    z.object({ ok: z.literal(false), failure: z.string().min(1).max(1_000) }),
  ]),
});

export type EvidenceUpload = z.infer<typeof upload>;
export type SettledEvidenceUpload = z.infer<typeof settledUpload>;
export type RecordingSettlement = z.infer<typeof recordingSettlement>;

/** A recording settled: its id, and why it failed, or null when it is available. */
export interface SettledRecording {
  recordingId: string;
  error: string | null;
}

/**
 * A recording's targets: the video's resumable upload, and its poster's
 * signed PUT. `failed` says an earlier attempt already failed it,
 * which only a recording the runner reported ready may replace.
 */
export interface RecordingTargets {
  uploadId: string;
  failed: boolean;
  video: ResumableUploadTarget;
  poster: UploadTarget;
}

export const storageMethods = {
  /**
   * One signed upload per item, in order, or null for an object stored
   * already; a Suite's artifacts are registered first.
   */
  uploadsPrepare: defineJobMethod<[EvidenceUpload[]], Array<UploadTarget | null>>({
    args: z.tuple([z.array(upload).min(1).max(MAX_UPLOADS_PER_CALL)]),
    run: (context, uploads) => prepareEvidenceUploads(context, uploads),
  }),
  /** The recording registered, and its targets; null once it is available. */
  recordingPrepare: defineJobMethod<[string], RecordingTargets | null>({
    args: z.tuple([z.string().min(1).max(200)]),
    run: (context, caseRunId) => prepareRecording(context, caseRunId),
  }),
  /** Each item's failure, in order: the task's own, the one the server's check found, or null when it was kept. */
  uploadsSettle: defineJobMethod<[SettledEvidenceUpload[]], Array<string | null>>({
    args: z.tuple([z.array(settledUpload).min(1).max(MAX_UPLOADS_PER_CALL)]),
    run: (context, uploads) => settleEvidenceUploads(context, uploads),
  }),
  /** The recording and why it failed, or null when it is available; null itself when it was available already. */
  recordingSettle: defineJobMethod<[RecordingSettlement], SettledRecording | null>({
    args: z.tuple([recordingSettlement]),
    run: (context, settlement) => settleRecording(context, settlement),
  }),
};
