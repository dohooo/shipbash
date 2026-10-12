/** What the record renders with (control-plane agent-data/): the history tools' own lines and records. */
export declare const HISTORY_DIRECTORY: "history";
export declare const CASE_OPENINGS_FILE: "case-openings.json";
export declare const LEG_OPENING_FILE: "opening.md";
export declare const HISTORY_SCOPES: readonly ["this_run", "journey", "runs", "discovery"];
export type HistoryScope = (typeof HISTORY_SCOPES)[number];

export interface HistoryChecklistLine {
  id: string;
  goal: string;
  status: string;
  reason: string | null;
}

/** One walk as list_history lists it and read_history heads it. */
export interface HistoryWalkLine {
  id: string;
  title: string;
  role: string;
  revision: number | null;
  runId: string | null;
  attempt: number | null;
  round: number | null;
  recordedAt: string;
  outcome: string | null;
  summary: string | null;
  failureReason: string | null;
  checklist: HistoryChecklistLine[];
  actors: string[];
  handoff: { afterStep: number; reason: string } | null;
  url?: string;
  recordedAtMark?: string;
}

export interface HistoryRunLine {
  id: string;
  suiteRunId: string;
  runId: string;
  recordedAt: string | null;
  trigger: string | null;
  verdict: string | null;
  cases: Array<{ caseRunId: string; title: string; role: string; outcome: string | null; reason: string | null; walks: string[]; url?: string }>;
  url?: string;
  recordedAtMark?: string;
}

export interface HistorySessionLine {
  id: string;
  kind: string;
  status: string;
  recordedAt: string | null;
  summary: string | null;
  proposed: number;
  approved: number;
  recordedAtMark?: string;
  /** The session's console page, for the chat: its id above is a hash. */
  url?: string;
}

/** How the history speaks to its reader: a walker reads each record as no evidence of its own; the chat reads what they hold. */
export interface HistoryFraming {
  headings: Readonly<Record<HistoryScope, string>>;
  runCaveat: string;
  sessionCaveat: string;
  opening: string;
  /** What blocked means, said once beneath entries that show it; empty for a reader that is not told. */
  blocked: string;
}

export declare const WALKER_FRAMING: HistoryFraming;
export declare const CHAT_FRAMING: HistoryFraming;

export interface HistoryPageArgs {
  limit?: number | undefined;
  before?: string | undefined;
  journey?: string | undefined;
}

export declare function historyPage<Entry extends { id: string }>(
  entries: readonly Entry[],
  args: HistoryPageArgs,
): { shown: Entry[]; remaining: number };

export declare function historyPageText(
  scope: HistoryScope,
  page: { shown: ReadonlyArray<HistoryWalkLine | HistoryRunLine | HistorySessionLine>; remaining: number },
  now?: Date,
  framing?: HistoryFraming,
): string;

export declare function listHistoryText(
  scope: HistoryScope,
  entries: ReadonlyArray<HistoryWalkLine | HistoryRunLine | HistorySessionLine>,
  args: HistoryPageArgs,
  now?: Date,
  framing?: HistoryFraming,
): string;

export declare function renderWalk(
  entry: HistoryWalkLine,
  record: Record<string, unknown> | null,
  options: { find?: unknown; offset?: unknown; now: Date; revisionNow: number | null; runCaveat: string },
): string;

export declare function renderRun(run: HistoryRunLine, now?: Date, framing?: HistoryFraming): string;

export declare function renderDiscovery(session: HistorySessionLine, text: string | null, now?: Date, framing?: HistoryFraming): string;

export declare function notOnRecordText(id: string): string;

export declare function legOpeningNote(
  latest: { run: HistoryRunLine | null; session: HistorySessionLine | null },
  now?: Date,
  framing?: HistoryFraming,
): string | null;

/** The history paths the runner reads this run's own walks and its openings by (history-records.mjs historyPathsFrom). */
export interface HistoryPaths {
  root: string;
  outputRoot: string | null;
  caseId: string | null;
}

/** How the runner reads the files of this run's walks: node:fs/promises, or another. */
export interface HistoryIo {
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  readdir: (path: string) => Promise<string[]>;
}

export declare const HISTORY_TOOL_NAMES: readonly ["list_history", "read_history"];

export declare function historyToolDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;

export declare function caseOpeningNote(
  paths: HistoryPaths,
  options?: { hook?: boolean },
  io?: HistoryIo,
  now?: Date,
): Promise<string | null>;

export declare function activityOpeningNote(
  paths: HistoryPaths | null,
  read?: (path: string, encoding: "utf8") => Promise<string>,
): Promise<string | null>;

export declare function runHistoryTool(
  name: string,
  args: Record<string, unknown>,
  paths: HistoryPaths,
  records: (name: string, args: Record<string, unknown>) => Promise<string>,
  io?: HistoryIo,
  now?: Date,
): Promise<string>;
