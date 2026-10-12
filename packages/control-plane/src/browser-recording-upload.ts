import { createReadStream } from "node:fs";

import { Upload } from "tus-js-client";

import { BROWSER_RECORDING_MIME_TYPE } from "@shipbash/contracts/runtime/browser-recording-format.mjs";

import type { ResumableUploadTarget } from "./storage-objects.ts";

const VIDEO_UPLOAD_TIMEOUT_MS = 10 * 60 * 1_000;
const VIDEO_UPLOAD_CHUNK_BYTES = 6 * 1024 * 1024;

/**
 * The recording's video, resumably, on the upload the server signed for it:
 * the token travels as `x-signature`, so the task holds no Storage key.
 * Abort a stalled TUS request; retries alone do not bound a silent socket.
 */
export async function uploadBrowserVideo(input: {
  videoPath: string;
  sizeBytes: number;
  target: ResumableUploadTarget;
}): Promise<void> {
  const stream = createReadStream(input.videoPath);
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const upload = new Upload(stream, {
        endpoint: input.target.endpoint,
        uploadSize: input.sizeBytes,
        chunkSize: VIDEO_UPLOAD_CHUNK_BYTES,
        retryDelays: [0, 3_000, 5_000, 10_000, 20_000],
        headers: input.target.headers,
        metadata: {
          bucketName: input.target.bucket,
          objectName: input.target.objectPath,
          contentType: BROWSER_RECORDING_MIME_TYPE,
          cacheControl: "3600",
        },
        uploadDataDuringCreation: true,
        removeFingerprintOnSuccess: true,
        onError: (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
        onSuccess: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stream.destroy();
        void upload.abort(true).catch(() => undefined);
        reject(new Error("Browser recording upload timed out."));
      }, VIDEO_UPLOAD_TIMEOUT_MS);
      upload.start();
    });
  } catch (error) {
    stream.destroy();
    throw new Error("Browser recording upload failed.", { cause: error });
  }
}
