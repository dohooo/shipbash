/**
 * The task's half of keeping evidence files, in either lane: each file is
 * hashed where it lies, the job API signs an upload for it, the task puts the
 * bytes itself, and the server settles every file, put or not, so each one
 * ends available or failed with its reason.
 */
import { createHash } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { ARTIFACT_BUCKET_FILE_SIZE_LIMIT_BYTES } from "../artifact-storage-contract.ts";
import type { SettledEvidenceUpload } from "../job-api/methods/storage.ts";
import type { JobPort } from "../job-api/port.ts";
import { errorMessage, safeText } from "../service/http-input.ts";
import type { UploadTarget } from "../storage-objects.ts";
import { artifactTooLarge } from "./artifact-files.ts";
import { mapConcurrent } from "./map-concurrent.ts";

/** The job API methods evidence retention calls: a Sandbox passes its remote port, the local lane its own. */
export type EvidencePort = Pick<
  JobPort,
  "uploadsPrepare" | "uploadsSettle" | "recordingPrepare" | "recordingSettle" | "appendRunEventsForJob" | "appendActivityEventsForJob"
>;

/** One file to keep: where it lies, and the group and walk path the server derives its object from. */
export interface EvidenceFile {
  path: string;
  group: string;
  sourcePath: string;
}

/** Per job API call: the server signs or checks this many uploads at most, with bounded concurrency. */
export const MAX_UPLOADS_PER_CALL = 100;

const PUT_CONCURRENCY = 6;
const PUT_ATTEMPTS = 3;
const PUT_TIMEOUT_MS = 5 * 60 * 1_000;
const EMPTY_SHA256 = createHash("sha256").digest("hex");

/** A failure as the server records it: bounded, credential-free, never empty. */
export function failureText(error: unknown): string {
  return safeText(errorMessage(error), 1_000) || "The evidence could not be retained.";
}

/** Storage answered the upload and refused it: an answer, so it is not retried. */
export class UploadRefused extends Error {
  override readonly name = "UploadRefused";
}

/**
 * Puts one file on its signed upload, up to three times. An object already at
 * the path holds these bytes — an artifact's path is content-addressed and a
 * recording attempt's paths are its own — so "already exists" is success.
 */
export async function putFile(target: UploadTarget, path: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(target.url, {
        method: "PUT",
        headers: target.headers,
        body: await openAsBlob(path),
        signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
      });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      const answer = await response.text().catch(() => "");
      if (response.status === 409 || /already exists|duplicate/iu.test(answer)) return;
      const refused = `Storage refused the upload with HTTP ${String(response.status)}: ${answer.slice(0, 200)}`;
      if (response.status < 500 && response.status !== 408 && response.status !== 429) throw new UploadRefused(refused);
      throw new Error(refused);
    } catch (error) {
      if (error instanceof UploadRefused || attempt >= PUT_ATTEMPTS) throw error;
      await delay(attempt * 1_000);
    }
  }
}

/** A file as the server takes it: its hash and size, or why it cannot be sent at all. */
async function described(file: EvidenceFile): Promise<SettledEvidenceUpload> {
  const upload = { group: file.group, sourcePath: file.sourcePath };
  try {
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of createReadStream(file.path)) {
      hash.update(chunk);
      sizeBytes += chunk.length;
    }
    const failure = sizeBytes > ARTIFACT_BUCKET_FILE_SIZE_LIMIT_BYTES ? artifactTooLarge(sizeBytes) : null;
    return { ...upload, sha256: hash.digest("hex"), sizeBytes, failure };
  } catch (error) {
    return { ...upload, sha256: EMPTY_SHA256, sizeBytes: 0, failure: failureText(error) };
  }
}

function batches<Item>(items: readonly Item[]): Item[][] {
  const result: Item[][] = [];
  for (let start = 0; start < items.length; start += MAX_UPLOADS_PER_CALL) {
    result.push(items.slice(start, start + MAX_UPLOADS_PER_CALL));
  }
  return result;
}

/**
 * One batch's bytes: signed together, put six at a time. A batch the server
 * would not sign is not lost: each of its files is settled as failed, with
 * the reason.
 */
async function putBatch(port: EvidencePort, batch: ReadonlyArray<{ upload: SettledEvidenceUpload; path: string }>): Promise<void> {
  let targets: Array<UploadTarget | null>;
  try {
    targets = await port.uploadsPrepare(batch.map(({ upload }) => upload));
  } catch (error) {
    for (const { upload } of batch) upload.failure = failureText(error);
    return;
  }
  await mapConcurrent(batch, PUT_CONCURRENCY, async ({ upload, path }, index) => {
    const target = targets[index];
    // null: Storage holds this object already, and the server's check will find it.
    if (target === null) return;
    upload.failure = target
      ? await putFile(target, path).then(() => null, failureText)
      : "The job API signed no upload for this file.";
  });
}

/** Each file's failure, in order, as the server settled it; null for a file it kept. */
export async function transferFiles(port: EvidencePort, files: readonly EvidenceFile[]): Promise<Array<string | null>> {
  const entries = await mapConcurrent(files, PUT_CONCURRENCY, async (file) => ({ upload: await described(file), path: file.path }));
  for (const batch of batches(entries.filter(({ upload }) => !upload.failure))) await putBatch(port, batch);
  const failures: Array<string | null> = [];
  for (const batch of batches(entries)) {
    failures.push(...(await port.uploadsSettle(batch.map(({ upload }) => upload))));
  }
  return failures;
}
