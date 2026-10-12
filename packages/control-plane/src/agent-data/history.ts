/**
 * list_history and read_history, answered from the record under a job's
 * scope (store/history-for-job.ts): the Journeys' earlier walks, the earlier
 * runs and the earlier sessions as they stood when the job was claimed,
 * rendered with the runner's own lines (history-tools.mjs). Only the step
 * records a page shows are downloaded, or the one a read asks for, and no
 * query holds a connection across a download. This run's own walks are the
 * runner's to read; a caller here has none.
 *
 * The chat, the one reader handed console pages, reads the history to answer
 * the owner: every run, Journey of a run and walk carries its page, every
 * record its time as a Slack date mark, which shows each reader their own
 * time zone, and nothing is framed as no evidence for a walk of its own
 * (history-tools.mjs CHAT_FRAMING). A walker reads it as WALKER_FRAMING says.
 */
import type postgres from "postgres";

import {
  CHAT_FRAMING,
  type HistoryFraming,
  historyPage,
  historyPageText,
  legOpeningNote,
  listHistoryText,
  notOnRecordText,
  renderDiscovery,
  renderRun,
  renderWalk,
  WALKER_FRAMING,
} from "@shipbash/runner/runtime/history-tools.mjs";

import type { SupabaseArtifactStorage } from "../artifact-storage.ts";
import { type ConsoleLinks, activityUrl, journeyUrl, runUrl } from "../console-links.ts";
import { isRecord } from "../is-record.ts";
import { localDateTime } from "../slack-block-kit.ts";
import {
  type RunHistoryRun,
  type RunHistoryWalk,
  runEntry,
  sessionEntry,
  sessionText,
  shortId,
  walkFromCaseRun,
  walkFromRecord,
  walkId,
} from "../run-history.ts";
import {
  earlierCaseRuns,
  earlierRunNamed,
  earlierRuns,
  type HistoryCaseRun,
  type HistoryJourney,
  type HistoryRun,
  type HistoryScope,
  HISTORY_RUNS,
  historyJourneys,
  runCasesOf,
  walkArtifactsOf,
} from "../store/history-for-job.ts";
import { earlierSessions, type HistorySession, sessionEvents } from "../store/history-for-project.ts";

/** Where a job's history is read from, for whom, and how its records are linked. */
export interface HistoryReader {
  sql: postgres.Sql;
  storage: Pick<SupabaseArtifactStorage, "downloadObject"> | null;
  scope: HistoryScope;
  /** The case agent's own Case, which an unnamed Journey defaults to; null for an Activity's agent. */
  caseId: string | null;
  /** The chat's console pages, shown in place of run ids; null elsewhere. */
  links: ConsoleLinks | null;
}

export interface ListHistoryArgs {
  scope: "this_run" | "journey" | "runs" | "discovery";
  journey?: string | undefined;
  limit?: number | undefined;
  before?: string | undefined;
}

export interface ReadHistoryArgs {
  id: string;
  find?: string | undefined;
  offset?: number | undefined;
}

/** A walk on record before its step record is read: its Case Run, its id, and where the record is kept. */
interface WalkSlot {
  id: string;
  caseRun: HistoryCaseRun;
  objectPath: string | null;
}

/** Every walk of these Journeys on record, newest first: one per step record, or the Case Run's own when it kept none. */
async function walkIndex(reader: HistoryReader, journeys: HistoryJourney[], perJourney?: number): Promise<WalkSlot[]> {
  const caseRuns = await earlierCaseRuns(reader.sql, reader.scope, journeys.map((journey) => journey.key), perJourney);
  const artifacts = await walkArtifactsOf(reader.sql, reader.scope, caseRuns.map((caseRun) => caseRun.id));
  return caseRuns.flatMap((caseRun): WalkSlot[] => {
    const records = artifacts.filter((artifact) => artifact.case_run_id === caseRun.id);
    if (!records.length) return [{ id: walkId(caseRun), caseRun, objectPath: null }];
    // A record that was not kept tells its walk by the verdict alone.
    return records.map((artifact) => ({
      id: walkId(artifact), caseRun, objectPath: artifact.storage_status === "available" ? artifact.object_path : null,
    }));
  });
}

/** A walk's step record, or null when it kept none or it cannot be read: the walk is then told by its verdict. */
async function stepRecord(reader: HistoryReader, slot: WalkSlot): Promise<Record<string, unknown> | null> {
  if (!reader.storage || !slot.objectPath) return null;
  try {
    const { body } = await reader.storage.downloadObject(slot.objectPath, "application/json");
    const record: unknown = JSON.parse(body.toString("utf8"));
    return isRecord(record) ? record : null;
  } catch {
    return null;
  }
}

/** How the history speaks to its reader: the chat's when it is handed console pages, a walker's otherwise. */
function framingOf(reader: HistoryReader): HistoryFraming {
  return reader.links ? CHAT_FRAMING : WALKER_FRAMING;
}

/** When a record was made, as a Slack date mark the chat writes through; none for a walker, or with no time. */
function recordedAtMark(reader: HistoryReader, recordedAt: string | null): { recordedAtMark?: string } {
  return reader.links && recordedAt && Number.isFinite(Date.parse(recordedAt)) ? { recordedAtMark: localDateTime(recordedAt) } : {};
}

function walkEntry(reader: HistoryReader, slot: WalkSlot, record: Record<string, unknown> | null): RunHistoryWalk {
  const entry = record ? walkFromRecord(slot.caseRun, record, slot.id) : walkFromCaseRun(slot.caseRun, slot.id);
  if (!reader.links) return entry;
  return { ...entry, url: journeyUrl(reader.links, entry.runId, entry.caseRunId), ...recordedAtMark(reader, entry.recordedAt) };
}

async function readWalk(reader: HistoryReader, slot: WalkSlot) {
  const record = await stepRecord(reader, slot);
  return { entry: walkEntry(reader, slot, record), record };
}

/**
 * The walks of the Journey a caller names — its key, one of its Case ids, or
 * a piece of its title, then or now — or, unnamed, of the Case being walked,
 * or of every Journey for a caller walking none.
 */
function namedWalks(slots: WalkSlot[], journeys: HistoryJourney[], name: string | undefined, caseId: string | null): WalkSlot[] {
  const wanted = name?.trim().toLowerCase() || null;
  if (!wanted && !caseId) return slots;
  const named = (journey: HistoryJourney) => wanted !== null && (journey.key.toLowerCase() === wanted
    || journey.caseIds.some((id) => id.toLowerCase() === wanted) || journey.title.toLowerCase().includes(wanted));
  const keys = new Set(wanted
    ? [...journeys.filter(named).map((journey) => journey.key),
      ...slots.filter((slot) => slot.caseRun.title.toLowerCase().includes(wanted)).map((slot) => slot.caseRun.suite_case_id)]
    : journeys.filter((journey) => caseId !== null && journey.caseIds.includes(caseId)).map((journey) => journey.key));
  return slots.filter((slot) => keys.has(slot.caseRun.suite_case_id));
}

/** Each Case Run's walk ids, as the walk index names them: what read_history of a run points at. */
async function walkIdsByCaseRun(reader: HistoryReader): Promise<Map<string, string[]>> {
  const slots = await walkIndex(reader, await historyJourneys(reader.sql, reader.scope));
  const walkIds = new Map<string, string[]>();
  for (const slot of slots) walkIds.set(slot.caseRun.id, [...(walkIds.get(slot.caseRun.id) ?? []), slot.id]);
  return walkIds;
}

/** These earlier runs as their entries, each Case with its verdict — and the walks it left, when `walks` asks for them. */
async function runEntries(reader: HistoryReader, runs: HistoryRun[], walks: boolean): Promise<RunHistoryRun[]> {
  const { sql, scope, links } = reader;
  const [cases, walkIds] = await Promise.all([
    runCasesOf(sql, scope.teamId, runs.map((run) => run.id)),
    walks ? walkIdsByCaseRun(reader) : new Map<string, string[]>(),
  ]);
  return runs.map((run) => {
    const entry = runEntry(run, cases, walkIds);
    if (!links) return entry;
    return {
      ...entry,
      url: runUrl(links, entry.runId),
      ...recordedAtMark(reader, entry.recordedAt),
      cases: entry.cases.map((walked) => ({ ...walked, url: journeyUrl(links, entry.runId, walked.caseRunId) })),
    };
  });
}

/**
 * A page of the earlier runs: the window's light rows paged as list_history
 * pages, and only the shown runs' Cases read; the page that ends the window
 * says when older runs lie past it.
 */
async function runsPage(reader: HistoryReader, args: ListHistoryArgs, now: Date, framing: HistoryFraming): Promise<string> {
  const read = await earlierRuns(reader.sql, reader.scope, HISTORY_RUNS + 1);
  const runs = read.slice(0, HISTORY_RUNS).map((run) => ({ id: shortId("r", run.id), run }));
  if (!runs.length) return listHistoryText("runs", [], args, now, framing);
  const page = historyPage(runs, args);
  const shown = await runEntries(reader, page.shown.map((entry) => entry.run), false);
  const text = historyPageText("runs", { shown, remaining: page.remaining }, now, framing);
  return read.length > HISTORY_RUNS && page.remaining === 0
    ? `${text}\n(Older runs than these ${String(HISTORY_RUNS)} are on record; list_history and read_history do not reach them.)`
    : text;
}

/** The earlier sessions of an Activity's Project; a Suite Run has none to read. */
function sessions(reader: HistoryReader, limit?: number): Promise<HistorySession[]> {
  const { activityId } = reader.scope;
  return activityId ? earlierSessions(reader.sql, { ...reader.scope, activityId }, limit) : Promise.resolve([]);
}

/** A session's line, its time a date mark and its page linked for the chat, whose evidence command takes the id the link carries. */
function sessionLine(reader: HistoryReader, session: HistorySession) {
  const entry = sessionEntry(session);
  return reader.links
    ? { ...entry, url: activityUrl(reader.links, session.id), ...recordedAtMark(reader, entry.recordedAt) }
    : entry;
}

export async function listHistory(reader: HistoryReader, args: ListHistoryArgs): Promise<string> {
  const now = new Date();
  const framing = framingOf(reader);
  if (args.scope === "this_run") return listHistoryText("this_run", [], args, now, framing);
  if (args.scope === "runs") return runsPage(reader, args, now, framing);
  if (args.scope === "discovery") {
    return listHistoryText("discovery", (await sessions(reader)).map((session) => sessionLine(reader, session)), args, now, framing);
  }
  const journeys = await historyJourneys(reader.sql, reader.scope);
  const slots = namedWalks(await walkIndex(reader, journeys), journeys, args.journey, reader.caseId);
  if (!slots.length) return listHistoryText("journey", [], args, now, framing);
  const page = historyPage(slots, args);
  const shown = await Promise.all(page.shown.map(async (slot) => (await readWalk(reader, slot)).entry));
  return historyPageText("journey", { shown, remaining: page.remaining }, now, framing);
}

async function readEarlierWalk(reader: HistoryReader, args: ReadHistoryArgs, now: Date): Promise<string | null> {
  const journeys = await historyJourneys(reader.sql, reader.scope);
  const slot = (await walkIndex(reader, journeys)).find((candidate) => candidate.id === args.id);
  if (!slot) return null;
  const { entry, record } = await readWalk(reader, slot);
  const walked = journeys.find((journey) => reader.caseId !== null && journey.caseIds.includes(reader.caseId));
  const revisionNow = walked?.key === entry.journey ? walked.revision : null;
  return renderWalk(entry, record, { find: args.find, offset: args.offset, now, revisionNow, runCaveat: framingOf(reader).runCaveat });
}

async function readEarlierSession(reader: HistoryReader, id: string, now: Date): Promise<string | null> {
  const session = (await sessions(reader)).find((candidate) => shortId("d", candidate.id) === id);
  if (!session) return null;
  const text = sessionText(session, await sessionEvents(reader.sql, reader.scope.teamId, session.id));
  return renderDiscovery(sessionLine(reader, session), text, now, framingOf(reader));
}

export async function readHistory(reader: HistoryReader, args: ReadHistoryArgs): Promise<string> {
  const now = new Date();
  const { id } = args;
  if (id.startsWith("w")) return (await readEarlierWalk(reader, args, now)) ?? notOnRecordText(id);
  if (id.startsWith("d")) return (await readEarlierSession(reader, id, now)) ?? notOnRecordText(id);
  const run = id.startsWith("r") ? await earlierRunNamed(reader.sql, reader.scope, id) : null;
  const [entry] = run ? await runEntries(reader, [run], true) : [];
  return entry ? renderRun(entry, now, framingOf(reader)) : notOnRecordText(id);
}

/**
 * What a Discovery or maintenance brief opens with: the Project's newest run
 * and its newest earlier session, one line each, or null when the record
 * holds neither.
 */
export async function latestHistoryNote(reader: HistoryReader): Promise<string | null> {
  const [runs, latest] = await Promise.all([
    earlierRuns(reader.sql, reader.scope, 1).then((newest) => runEntries(reader, newest, false)),
    sessions(reader, 1),
  ]);
  return legOpeningNote({ run: runs[0] ?? null, session: latest[0] ? sessionLine(reader, latest[0]) : null }, new Date(), framingOf(reader));
}

/** The newest earlier walk of each Journey and hook of a Suite Run, by each of its snapshot Case ids. */
export async function newestWalks(reader: HistoryReader): Promise<Record<string, RunHistoryWalk>> {
  const journeys = await historyJourneys(reader.sql, reader.scope);
  const newest = new Map<string, WalkSlot>();
  for (const slot of await walkIndex(reader, journeys, 1)) {
    if (!newest.has(slot.caseRun.suite_case_id)) newest.set(slot.caseRun.suite_case_id, slot);
  }
  const walks = await Promise.all([...newest.values()].map(async (slot) => (await readWalk(reader, slot)).entry));
  return Object.fromEntries(journeys.flatMap((journey) => {
    const walk = walks.find((entry) => entry.journey === journey.key);
    return walk ? journey.caseIds.map((caseId) => [caseId, walk]) : [];
  }));
}
