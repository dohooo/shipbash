/**
 * Knowledge as an agent reads it, one line per entry: the recall corpus the
 * record packs on demand (knowledge-opening.ts, agent-data/) and the page
 * notes a leg's control mount carries (activity-control-files.ts).
 */
import { isAbsolute, resolve } from "node:path";

/** One piece of knowledge as an agent reads it: a corpus line, or a page note. */
export interface KnowledgeLine {
  id: string;
  kind: string;
  title: string;
  pageKey: string | null;
  line: string;
}

/**
 * A control path is always harness-supplied; a relative or comma-bearing one
 * would mean the caller lost track of which run it is steering. Every writer
 * into a control mount checks it (activity-control-files.ts).
 */
export function checkedAbsolutePath(path: string, field: string): string {
  if (!isAbsolute(path)) throw new Error(`${field} must be an absolute path.`);
  if (path.includes(",") || path.includes("\0")) throw new Error(`${field} contains unsupported characters.`);
  return resolve(path);
}
