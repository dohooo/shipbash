import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { SuiteCaseRunReference } from "./dispatch-worker-types.ts";

const OUTPUT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u;

/** Resolve only a real directory inside the host-created output root. */
export async function recordingWalkDirectory(
  outputRoot: string,
  reference: SuiteCaseRunReference,
): Promise<string | null> {
  if (!OUTPUT_SEGMENT.test(reference.directory) || reference.directory.includes("..")) {
    throw new Error("Browser recording walk directory is invalid.");
  }
  const root = await realpath(outputRoot);
  const candidate = resolve(root, reference.directory);
  const entry = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!entry) return null;
  if (entry.isSymbolicLink()) throw new Error("Browser recording walk escaped its output root.");
  if (!entry.isDirectory()) return null;
  const actual = await realpath(candidate);
  const path = relative(root, actual);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("Browser recording walk escaped its output root.");
  }
  return actual;
}
