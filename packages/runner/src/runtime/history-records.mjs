// The records the runner reads itself, from two places: the openings the host
// wrote into the control root before the run started (history/: each
// Journey's newest earlier walk by case id, and a leg's opening note), and
// this run's own finished walks, which the suite runner writes under the
// output root as it goes (suite-runner/walk-record.mjs). Everything else
// earlier is read on demand from the record (control-plane agent-data/),
// never from a file.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Where the host writes the openings, beneath the control root. */
export const HISTORY_DIRECTORY = "history";
/** A Suite Run's case openings: the newest earlier walk of each Journey and hook, by its snapshot case id. */
export const CASE_OPENINGS_FILE = "case-openings.json";
/** An Activity leg's opening note: the Project's newest run and earlier session. */
export const LEG_OPENING_FILE = "opening.md";
const WALK_FILE = "walk.json";
// Where a walk writes its evidence (case-artifacts.mjs caseArtifactPath): an
// attempt's first walk in <case>/attempt-<n>/, each later walk of that attempt
// — a sign-in validation, a reproduction — in auth-validation-<m>/ beneath it.
const ATTEMPT_DIRECTORY = /^attempt-\d+$/u;
const LATER_WALK_DIRECTORY = /^auth-validation-\d+$/u;

/**
 * The history paths beneath the control root and the output root, or null without a control root.
 * @param {{ controlRoot: string | undefined, outputRoot?: string | null, caseId?: string | null }} roots
 * @returns {{ root: string, outputRoot: string | null, caseId: string | null } | null}
 */
export function historyPathsFrom({ controlRoot, outputRoot = null, caseId = null }) {
  const root = typeof controlRoot === "string" ? controlRoot.trim().replace(/\/+$/u, "") : "";
  if (!root) return null;
  const output = typeof outputRoot === "string" && outputRoot.trim() ? outputRoot.trim() : null;
  return {
    root: `${root}/${HISTORY_DIRECTORY}`,
    outputRoot: output,
    caseId: typeof caseId === "string" && caseId.trim() ? caseId.trim() : null,
  };
}

async function readJson(path, read) {
  try {
    return JSON.parse(await read(path, "utf8"));
  } catch {
    return null;
  }
}

const list = (value) => (Array.isArray(value) ? value : []);

/** `object[key]` when it is of `kind`, else the fallback. */
const field = (object, key, kind, fallback = null) =>
  object && typeof object === "object" && typeof object[key] === kind ? object[key] : fallback;

/** The verdict line a walk record carries, in the index's own shape. */
export function walkEntryFrom(record, id, scope) {
  const result = field(record, "result", "object", {});
  return {
    id,
    scope,
    journey: field(record, "caseId", "string"),
    title: field(record, "title", "string", "Untitled"),
    role: field(record, "role", "string", "journey"),
    revision: field(record, "revision", "number"),
    runId: field(record, "runId", "string"),
    attempt: field(record, "attempt", "number"),
    round: field(record, "round", "number"),
    recordedAt: field(record, "endedAt", "string", field(record, "startedAt", "string")),
    outcome: field(result, "outcome", "string"),
    summary: field(result, "summary", "string"),
    failureReason: field(result, "failureReason", "string"),
    checklist: list(field(result, "checklist", "object")),
    actors: [...new Set(list(field(record, "steps", "object")).map((step) => step?.actor).filter(Boolean))],
    handoff: field(record, "handoff", "object"),
  };
}

/** A this-run walk's short id: stable for its directory, distinct from the record's (control-plane agent-data/). */
function thisRunId(directory) {
  return `t${createHash("sha256").update(directory).digest("hex").slice(0, 6)}`;
}

/**
 * The walk records under one Journey's evidence directory, each with its
 * directory relative to it: every attempt's first walk and each later walk of
 * that attempt. A record that does not parse is left out.
 * @param {string} caseDirectory
 * @param {{ readdir: (path: string) => Promise<string[]>, readFile: (path: string, encoding: "utf8") => Promise<string> }} [fs]
 * @returns {Promise<Array<{ directory: string, record: Record<string, any> }>>}
 */
export async function caseWalkRecords(caseDirectory, fs = { readdir, readFile }) {
  const directories = [];
  for (const attempt of await fs.readdir(caseDirectory).catch(() => [])) {
    if (!ATTEMPT_DIRECTORY.test(attempt)) continue;
    directories.push(attempt);
    for (const later of await fs.readdir(join(caseDirectory, attempt)).catch(() => [])) {
      if (LATER_WALK_DIRECTORY.test(later)) directories.push(`${attempt}/${later}`);
    }
  }
  const walks = [];
  for (const directory of directories) {
    const record = await readJson(join(caseDirectory, directory, WALK_FILE), fs.readFile);
    if (record) walks.push({ directory, record });
  }
  return walks;
}

/**
 * This run's finished walks, newest first, each with its full record. A walk
 * still in progress — the caller's own, above all — has no result yet and is
 * left out.
 */
export async function readThisRunWalks(paths, fs = { readdir, readFile }) {
  if (!paths.outputRoot) return [];
  const walks = [];
  for (const caseDirectory of await fs.readdir(paths.outputRoot).catch(() => [])) {
    for (const { directory, record } of await caseWalkRecords(join(paths.outputRoot, caseDirectory), fs)) {
      if (record.result) walks.push({ entry: walkEntryFrom(record, thisRunId(`${caseDirectory}/${directory}`), "this_run"), record });
    }
  }
  return walks.sort((left, right) => String(right.entry.recordedAt).localeCompare(String(left.entry.recordedAt)));
}

/** The newest earlier walk of the case being walked, as the host wrote it before the run, or null. */
export async function readCaseOpening(paths, read = readFile) {
  if (!paths.caseId) return null;
  const openings = await readJson(join(paths.root, CASE_OPENINGS_FILE), read);
  const entry = openings && Object.hasOwn(openings, paths.caseId) ? openings[paths.caseId] : null;
  return entry && typeof entry === "object" ? { ...entry, scope: "journey" } : null;
}
