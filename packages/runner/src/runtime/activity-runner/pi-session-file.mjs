// The Activity's persisted pi session: the transcript every leg resumes
// (pi-agent-slot.mjs).
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** The newest persisted session file, if an earlier leg left one. */
export async function newestSessionFile(directory) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return null;
  }
  let newest = null;
  for (const name of names.filter((entry) => entry.endsWith(".jsonl"))) {
    const path = join(directory, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    if (!newest || info.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: info.mtimeMs };
  }
  return newest?.path ?? null;
}
