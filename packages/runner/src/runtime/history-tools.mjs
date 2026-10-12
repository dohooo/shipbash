// The run-history tools: list_history returns an index of ShipBash's own
// earlier work, read_history one record in detail. Index first, detail on
// demand, bounded output, and every record says when it was made and that it
// describes that walk, not the page in front of the reader. They return what
// was observed — values typed, page text, verdicts and their reasons — never
// what this walk should do. Earlier runs, their walks and earlier sessions
// are the record's own answer (control-plane agent-data/, which renders them
// with this module's functions); this run's own finished walks — this_run,
// the t… ids — are read here, from the files the runner wrote
// (history-records.mjs). A run, a Journey of a run or a walk the host gave a
// console page (the chat's) shows that page, and a record it gave a date mark
// shows that mark. Who reads them sets their framing: a walker reads each
// record with the caveat that it is no evidence for its own verdict; the
// chat, which answers the owner and judges no walk, reads what they hold.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { LEG_OPENING_FILE, readCaseOpening, readThisRunWalks } from "./history-records.mjs";
import { CUT_MARK, indexLine, openingNote, renderWalk, walkLine, when } from "./history-render.mjs";

export { CASE_OPENINGS_FILE, HISTORY_DIRECTORY, LEG_OPENING_FILE } from "./history-records.mjs";
export { renderWalk } from "./history-render.mjs";

export const HISTORY_TOOL_NAMES = Object.freeze(["list_history", "read_history"]);
export const HISTORY_SCOPES = Object.freeze(["this_run", "journey", "runs", "discovery"]);
const LIST_LIMIT = 20;
const LIST_DEFAULT = 10;

export function historyToolDefinitions() {
  return [
    {
      name: "list_history",
      description:
        "List ShipBash's records of its own earlier work on this product, newest first, one line each with an id for read_history. "
        + "scope this_run: walks already finished in this run — earlier walks of this Journey and the setups and Journeys walked before it; "
        + "journey: this Journey (or the one `journey` names) in earlier runs, with what failed or was handed over; "
        + "runs: earlier runs, one line each; discovery: earlier Discovery sessions. "
        // Outside a case there is no case id and no walk output (progress-session.mjs
        // progressOptions): this_run reads nothing.
        + "Outside a Journey walk this_run is empty. "
        + `Shows ${String(LIST_DEFAULT)} lines unless limit says otherwise (at most ${String(LIST_LIMIT)}); a line cut short ends in ${CUT_MARK}, and read_history shows that record in detail. `
        + "A record describes that walk, not the page in front of you: use it to find and understand what this page shows, never as evidence for this verdict.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          scope: { type: "string", enum: [...HISTORY_SCOPES] },
          journey: { type: "string", description: "A Journey id or part of its title; defaults to the Journey being walked, or to every Journey when none is." },
          limit: { type: "integer", minimum: 1, maximum: LIST_LIMIT },
          before: { type: "string", description: "The last id of the previous page." },
        },
        required: ["scope"],
      },
    },
    {
      name: "read_history",
      description:
        "Read one record from list_history by id. A walk: its verdict with every checkpoint's reason, then its steps — who acted (Jev or the supervising agent), "
        + "the call with the values actually typed, the URL, and the page text after. `find` returns only the steps containing that text "
        + "(case-insensitive); the verdict and its reasons always show. `offset` starts from a step number, with or without `find`, and an answer "
        + `that stops short ends with the offset to go on from. A step's line cut short ends in ${CUT_MARK}. It describes that walk, not the page in front of you.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          find: { type: "string", maxLength: 200 },
          offset: { type: "integer", minimum: 1 },
        },
        required: ["id"],
      },
    },
  ];
}

/** The page of newest-first entries a list_history call shows: after `before`, at most `limit`, and how many remain. */
export function historyPage(entries, args) {
  const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), LIST_LIMIT) : LIST_DEFAULT;
  const start = typeof args.before === "string" ? entries.findIndex((entry) => entry.id === args.before) + 1 : 0;
  const shown = entries.slice(start, start + limit);
  return { shown, remaining: entries.length - start - shown.length };
}

function runLine(run, now) {
  const counts = new Map();
  for (const entry of run.cases ?? []) counts.set(entry.outcome, (counts.get(entry.outcome) ?? 0) + 1);
  const tally = [...counts].map(([outcome, count]) => `${count} ${outcome}`).join(", ");
  const trouble = (run.cases ?? []).find((entry) => entry.outcome !== "passed" && entry.reason);
  return indexLine([
    `- ${run.id} · ${when(run, now)} · ${run.url ?? `run ${run.runId ?? run.suiteRunId}`}`,
    run.trigger ?? null,
    run.verdict ?? "unfinished",
    tally || null,
    trouble ? `"${trouble.title}": ${trouble.reason}` : null,
  ]);
}

function discoveryLine(session, now) {
  return indexLine([
    `- ${session.id} · ${when(session, now)} · ${session.kind} · ${session.status}`,
    session.url ?? null,
    typeof session.proposed === "number" ? `${session.proposed} proposed, ${session.approved ?? 0} approved` : null,
    session.summary ?? null,
  ]);
}

const HEADINGS = {
  this_run: "Walks already finished in this run, newest first. Records of those walks, not evidence for the one you are on.",
  journey: "Earlier walks of this Journey in earlier runs, newest first. Records of those runs, not evidence for this one.",
  runs: "Earlier runs, newest first. Records of those runs, not evidence for this one.",
  discovery: "Earlier Discovery sessions, newest first.",
};

/** How the history speaks to a walker, which must not take an earlier walk for evidence of its own. */
export const WALKER_FRAMING = Object.freeze({
  headings: HEADINGS,
  runCaveat: " — describes that run, not evidence for this one",
  sessionCaveat: " — describes that session, not this product today",
  opening: "History — records of ShipBash's earlier work on this product, not evidence about it today; list_history and read_history show them in full:",
  blocked: "",
});

/** How the history speaks to the chat, which reads it to answer the owner. */
export const CHAT_FRAMING = Object.freeze({
  headings: {
    this_run: "Walks already finished in this run, newest first.",
    journey: "Walks of Journeys in earlier runs, newest first.",
    runs: "Earlier runs, newest first.",
    discovery: HEADINGS.discovery,
  },
  runCaveat: "",
  sessionCaveat: "",
  opening: "History — ShipBash's latest work on this product; list_history and read_history show it in full:",
  blocked: "Blocked means not tested: data, a permission or the environment stopped the walk before it could check the product — it is not a product failure.",
});

/** Whether a run, one of its Journeys, or a walk the history shows was blocked. */
function isBlocked(entry) {
  return entry.verdict === "blocked" || entry.outcome === "blocked" || (entry.cases ?? []).some((walk) => walk.outcome === "blocked");
}

/** The framing's sentence on what blocked means, said once beneath entries that show it. */
function blockedNote(entries, framing) {
  return framing.blocked && entries.some(isBlocked) ? [framing.blocked] : [];
}

/** The scope a list_history call names, or the sentence that refuses it. */
function historyScope(args) {
  if (!HISTORY_SCOPES.includes(args.scope)) throw new Error(`scope must be one of ${HISTORY_SCOPES.join(", ")}.`);
  return args.scope;
}

/** A list_history answer from its page: the heading, a line per entry, and where the next page starts. */
export function historyPageText(scope, { shown, remaining }, now = new Date(), framing = WALKER_FRAMING) {
  const line = scope === "runs" ? runLine : scope === "discovery" ? discoveryLine : walkLine;
  // indexLine cuts every line to INDEX_LINE_CHARACTERS, so a page of `limit`
  // lines is bounded as it is and shows every entry it counts: `before`
  // resumes right after the last one.
  const text = [framing.headings[scope], ...shown.map((entry) => line(entry, now)), ...blockedNote(shown, framing)].join("\n");
  const last = shown.at(-1)?.id;
  return remaining > 0 && last ? `${text}\n(${remaining} more — list_history with before: "${last}")` : text;
}

/** A list_history answer over every entry of the scope, newest first. */
export function listHistoryText(scope, entries, args, now = new Date(), framing = WALKER_FRAMING) {
  if (entries.length === 0) {
    return scope === "journey" && typeof args.journey === "string"
      ? `No earlier walk of a Journey matching "${args.journey}" is on record.`
      : "Nothing is on record for that scope.";
  }
  return historyPageText(scope, historyPage(entries, args), now, framing);
}

export function renderRun(run, now = new Date(), framing = WALKER_FRAMING) {
  const lines = [
    `Earlier run ${run.runId ?? run.suiteRunId}, recorded ${when(run, now)}${framing.runCaveat}.`,
    ...(run.url ? [`Page: ${run.url}`] : []),
    `Verdict: ${run.verdict ?? "unfinished"}${run.trigger ? ` (${run.trigger})` : ""}`,
  ];
  for (const entry of run.cases ?? []) {
    const walks = (entry.walks ?? []).length ? ` · walks ${entry.walks.join(", ")}` : "";
    const page = entry.url ? ` · ${entry.url}` : "";
    lines.push(`- "${entry.title}" (${entry.role}) ${entry.outcome ?? "not run"}${entry.reason ? `: ${entry.reason}` : ""}${walks}${page}`);
  }
  return [...lines, ...blockedNote([run], framing)].join("\n");
}

/** An earlier session in full: its line's facts, then `text`, the session as the record keeps it. */
export function renderDiscovery(session, text, now = new Date(), framing = WALKER_FRAMING) {
  return [
    `Earlier ${session.kind} session${session.url ? ` (${session.url})` : ""}, recorded ${when(session, now)}${framing.sessionCaveat}.`,
    `Status: ${session.status}`,
    typeof text === "string" ? text.slice(0, 11_000) : session.summary ?? "No summary was recorded.",
  ].join("\n");
}

/** What read_history answers for an id no record has. */
export function notOnRecordText(id) {
  return `No record "${id}" is on file; list_history shows the ids.`;
}

/**
 * The note a case's brief opens with: the newest finished walk of this case in
 * this run — or, for a setup or teardown walked first, the newest walk of the
 * run, which is what it follows — and the newest walk of the same Journey in
 * earlier runs, as the host wrote it before the run. Null when neither exists.
 */
export async function caseOpeningNote(paths, { hook = false } = {}, io = { readFile, readdir }, now = new Date()) {
  const [walks, earlier] = await Promise.all([readThisRunWalks(paths, io), readCaseOpening(paths, io.readFile)]);
  const own = walks.find(({ entry }) => entry.journey === paths.caseId)?.entry ?? null;
  const thisRun = own ?? (hook ? walks[0]?.entry ?? null : null);
  return openingNote({ thisRun, earlier }, now);
}

/**
 * The note a Discovery or maintenance brief, or a new conversation, opens
 * with: the Project's newest run and its newest earlier session, each in one
 * line with the id that reads it in full. Null when the record holds neither.
 */
export function legOpeningNote({ run, session }, now = new Date(), framing = WALKER_FRAMING) {
  const lines = [
    ...(run ? [`- Latest run: ${runLine(run, now).slice(2)} (read_history id "${run.id}").`] : []),
    ...(session ? [`- Latest earlier session: ${discoveryLine(session, now).slice(2)} (read_history id "${session.id}").`] : []),
  ];
  if (!lines.length) return null;
  return [framing.opening, ...lines, ...blockedNote(run ? [run] : [], framing)].join("\n");
}

/** The leg's opening note as the host wrote it beneath the control root, or null. */
export async function activityOpeningNote(paths, read = readFile) {
  if (!paths) return null;
  const note = await read(join(paths.root, LEG_OPENING_FILE), "utf8").catch(() => "");
  return note.trim() || null;
}

/**
 * Runs a history tool in the runner: this run's own walks are read here, from
 * the files under the output root; everything earlier is `records`, the
 * record's own answer to the same call (task-api.mjs agentDataCaller).
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {{ root: string, outputRoot: string | null, caseId: string | null }} paths
 * @param {(name: string, args: Record<string, unknown>) => Promise<string>} records
 */
export async function runHistoryTool(name, args, paths, records, io = { readFile, readdir }, now = new Date()) {
  if (name === "list_history") {
    if (historyScope(args) !== "this_run") return records(name, args);
    const walks = await readThisRunWalks(paths, io);
    return listHistoryText("this_run", walks.map(({ entry }) => entry), args, now);
  }
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) throw new Error("id is required.");
  if (!id.startsWith("t")) return records(name, args);
  const found = (await readThisRunWalks(paths, io)).find(({ entry }) => entry.id === id);
  return found
    ? renderWalk(found.entry, found.record, { ...args, now, revisionNow: null, runCaveat: WALKER_FRAMING.runCaveat })
    : notOnRecordText(id);
}
