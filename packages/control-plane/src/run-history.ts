/**
 * A walk, a run and a session as the agent's history tools read them, shaped
 * from the record (store/history-for-job.ts, store/history-for-project.ts) —
 * agent-data/history.ts reads it, these shape it, and the runner's
 * history-tools.mjs renders it. A walk's id comes from the record alone: the
 * step record (walk.json) the walk retained, or the Case Run that retained
 * none. So a page names its walks with nothing downloaded, and an id means
 * the same walk on every call.
 */
import { createHash } from "node:crypto";

import { isRecord } from "./is-record.ts";
import type {
  HistoryCaseRun,
  HistoryRun,
  HistoryRunCase,
  HistoryWalkArtifact,
} from "./store/history-for-job.ts";
import type { HistorySession, HistorySessionEvent } from "./store/history-for-project.ts";

const SESSION_TEXT = 11_000;

interface HistoryChecklistItem { id: string; goal: string; status: string; reason: string | null }

export interface RunHistoryWalk {
  id: string;
  journey: string;
  title: string;
  role: string;
  revision: number | null;
  runId: string;
  suiteRunId: string;
  caseRunId: string;
  attempt: number;
  round: number | null;
  recordedAt: string;
  outcome: string | null;
  summary: string | null;
  failureReason: string | null;
  checklist: HistoryChecklistItem[];
  actors: string[];
  handoff: { afterStep: number; reason: string } | null;
  /** The walk's console page, and when it was recorded as a Slack date mark: only the chat's history carries them (agent-data/). */
  url?: string;
  recordedAtMark?: string;
}

/** A Journey or hook a run walked, as the run's record lists it. */
export interface RunHistoryCase {
  caseRunId: string;
  title: string;
  role: string;
  outcome: string | null;
  reason: string | null;
  walks: string[];
  /** The Journey run's console page: only the chat's history carries it (agent-data/). */
  url?: string;
}

/** A run on record. */
export interface RunHistoryRun {
  id: string;
  suiteRunId: string;
  runId: string;
  recordedAt: string | null;
  trigger: string | null;
  verdict: string | null;
  cases: RunHistoryCase[];
  /** The run's console page, and when it was recorded as a Slack date mark: only the chat's history carries them, as a walk's. */
  url?: string;
  recordedAtMark?: string;
}

export const shortId = (prefix: string, value: string) => `${prefix}${createHash("sha256").update(value).digest("hex").slice(0, 6)}`;
const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());
/** The run id that run's agents named its data by: a case retry walks under its root's. */
const familyRunId = (run: { id: string; source_suite_run_id: string | null; trigger_kind: string | null }) =>
  run.trigger_kind === "case_retry" && run.source_suite_run_id ? run.source_suite_run_id : run.id;
/** A reason's first sentence; a numbered heading's period ("2. Create your project") ends none. */
const firstSentence = (text: string | null) => (text ? (/^.*?(?<!\d)[.!?](?=\s|$)/u.exec(text)?.[0] ?? text).slice(0, 200) : null);

/** A walk's id: its step record's, or its Case Run's when it retained none. */
export const walkId = (source: HistoryWalkArtifact | HistoryCaseRun) => shortId("w", source.id);

function checklistOf(value: unknown): HistoryChecklistItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    id: String(item.id ?? ""),
    goal: String(item.goal ?? ""),
    status: String(item.status ?? ""),
    reason: typeof item.reason === "string" ? item.reason : null,
  }));
}

/** A walk as its Case Run settled it: the verdict alone, before (or without) its step record. */
export function walkFromCaseRun(caseRun: HistoryCaseRun, id: string): RunHistoryWalk {
  return {
    id,
    journey: caseRun.suite_case_id,
    title: caseRun.title,
    role: caseRun.role,
    revision: caseRun.suite_case_revision,
    runId: familyRunId({ ...caseRun, id: caseRun.suite_run_id }),
    suiteRunId: caseRun.suite_run_id,
    caseRunId: caseRun.id,
    attempt: caseRun.attempt,
    round: null,
    recordedAt: iso(caseRun.completed_at) ?? "",
    outcome: caseRun.verdict,
    summary: caseRun.summary,
    failureReason: caseRun.failure_reason,
    checklist: checklistOf(caseRun.checklist),
    actors: [],
    handoff: null,
  };
}

/** A walk as its step record tells it: the round, the actors, the handoff and the record's own verdict. */
export function walkFromRecord(caseRun: HistoryCaseRun, record: Record<string, unknown>, id: string): RunHistoryWalk {
  const result = isRecord(record.result) ? record.result : {};
  const steps = Array.isArray(record.steps) ? record.steps.filter(isRecord) : [];
  const handoff = isRecord(record.handoff) ? record.handoff : null;
  const settled = walkFromCaseRun(caseRun, id);
  return {
    ...settled,
    runId: typeof record.runId === "string" ? record.runId : settled.runId,
    round: typeof record.round === "number" ? record.round : null,
    recordedAt: typeof record.endedAt === "string" ? record.endedAt : settled.recordedAt,
    outcome: typeof result.outcome === "string" ? result.outcome : caseRun.verdict,
    summary: typeof result.summary === "string" ? result.summary : null,
    failureReason: typeof result.failureReason === "string" ? result.failureReason : null,
    checklist: checklistOf(result.checklist),
    actors: [...new Set(steps.map((step) => step.actor).filter((actor): actor is string => typeof actor === "string"))],
    handoff: handoff ? { afterStep: Number(handoff.afterStep ?? 0), reason: String(handoff.reason ?? "") } : null,
  };
}

export function runEntry(run: HistoryRun, cases: HistoryRunCase[], walkIds: Map<string, string[]>): RunHistoryRun {
  return {
    id: shortId("r", run.id),
    suiteRunId: run.id,
    runId: familyRunId(run),
    recordedAt: iso(run.completed_at ?? run.created_at),
    trigger: run.trigger_kind,
    verdict: run.verdict,
    cases: cases.filter((entry) => entry.suite_run_id === run.id).map((entry) => ({
      caseRunId: entry.id,
      title: entry.title,
      role: entry.role,
      outcome: entry.verdict,
      reason: firstSentence(entry.verdict === "passed" ? entry.summary : entry.failure_reason ?? entry.summary),
      walks: walkIds.get(entry.id) ?? [],
    })),
  };
}

export function sessionEntry(session: HistorySession) {
  return {
    id: shortId("d", session.id),
    kind: session.kind,
    status: session.status,
    recordedAt: iso(session.completed_at ?? session.created_at),
    summary: firstSentence(session.summary),
    proposed: session.proposed,
    approved: session.accepted,
  };
}

/** An earlier session in full: its result, then its narrative and the owner's words, newest last. */
export function sessionText(session: HistorySession, events: HistorySessionEvent[]): string {
  const lines = [
    `Result: ${session.summary ?? "none recorded"}`,
    `Journeys proposed: ${session.proposed}; kept by the owner: ${session.accepted}.`,
    ...events.map((event) => `— ${event.label}\n${event.body_markdown}`),
  ];
  const text = lines.join("\n");
  return text.length > SESSION_TEXT ? `${text.slice(0, SESSION_TEXT)}…` : text;
}
