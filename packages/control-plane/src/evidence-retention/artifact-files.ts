/**
 * A walk's output as retention sees it: the kind each file is, and the files
 * to keep. The browser recording's own files are left to the recording, and
 * the Chrome trace is kept compressed.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import type { ArtifactKind } from "@shipbash/contracts/database-contract-types";
import { BROWSER_RECORDING_FILES, CASE_REPLAY_FILE } from "@shipbash/contracts/runtime/browser-recording-format.mjs";

import { ARTIFACT_BUCKET_FILE_SIZE_LIMIT_BYTES } from "../artifact-storage-contract.ts";
import { errorMessage, safeText } from "../service/http-input.ts";

/** By name alone, so the server derives the same kind from the path the task names. */
export function artifactKind(path: string): ArtifactKind {
  const name = basename(path).toLowerCase();
  // The exported replay is the only video a case run leaves behind, known by
  // its name: the raw recording's segments are MP4 too and never the replay.
  if (name === CASE_REPLAY_FILE) return "video";
  if (/\.(png|jpe?g|webp)$/u.test(name)) return "screenshot";
  if (name.includes("trace")) return "trace";
  if (name.includes("console") || name.includes("error")) return "console";
  if (name.includes("timeline")) return "timeline";
  return "manifest";
}

/** Why a file is never sent: the bucket refuses anything larger. */
export function artifactTooLarge(sizeBytes: number): string {
  return `Artifact is ${String(sizeBytes)} bytes and exceeds the ${String(ARTIFACT_BUCKET_FILE_SIZE_LIMIT_BYTES)}-byte Storage limit.`;
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** A file the walk could not hand over at all, in the words its loss is announced with. */
export interface ArtifactFileFailure {
  kind: ArtifactKind;
  label: string;
  message: string;
}

export async function prepareArtifactFiles(
  directory: string,
): Promise<{ files: string[]; failures: ArtifactFileFailure[] }> {
  const files: string[] = [];
  const failures: ArtifactFileFailure[] = [];
  for (const path of await listFiles(directory)) {
    if (BROWSER_RECORDING_FILES.has(basename(path))) continue;
    if (basename(path) !== "chrome-trace.json") {
      files.push(path);
      continue;
    }
    const compressedPath = `${path}.gz`;
    try {
      await pipeline(
        createReadStream(path),
        createGzip({ level: 6 }),
        createWriteStream(compressedPath, { mode: 0o600 }),
      );
      files.push(compressedPath);
    } catch (error) {
      await unlink(compressedPath).catch(() => undefined);
      failures.push({
        kind: "trace",
        label: basename(path),
        message: safeText(`Trace compression failed: ${errorMessage(error)}`, 1_000),
      });
    }
  }
  return { files, failures };
}
