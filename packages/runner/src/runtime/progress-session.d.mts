import type { ChecklistItem } from "@shipbash/contracts/runtime/checklist-contract.mjs";

export interface ProgressHumanAuthPaths {
  requestPath: string;
  completePath: string;
  cancelPath: string;
  resumedPath: string;
  runCancelPath: string;
}

export type AgentDataCall = (name: string, args: Record<string, unknown>) => Promise<string>;

/** The terminal lane that answers the terminal trio (terminal-lane.mjs `request`). */
export interface TerminalAnswerer {
  request(request: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ProgressOptions {
  eventPath: string;
  narrationPath?: string | null;
  initialChecklist?: readonly ChecklistItem[] | null;
  append?: (path: string, content: string, options?: unknown) => unknown;
  humanAuth?: ProgressHumanAuthPaths | null;
  knowledge?: Record<string, string> | null;
  history?: { root: string; outputRoot: string | null; caseId: string | null } | null;
  /** The record's own answer to recall_knowledge and the history beyond this run; without it they refuse. */
  agentData?: AgentDataCall | null;
  terminal?: TerminalAnswerer | null;
  /** The session holds add_journey: list_journeys reads its own Journey list beside the record's. */
  keepsJourneyList: boolean;
  accessFile?: (path: string) => Promise<unknown>;
  readControlFile?: (path: string, options?: unknown) => Promise<unknown>;
  removeFile?: (path: string, options?: unknown) => Promise<unknown>;
  writeControlFile?: (path: string, content: string, options?: unknown) => Promise<unknown>;
  sleep?: (milliseconds: number) => Promise<unknown>;
}

/** A lane's options for its session's progress tools: whether the session keeps a Journey list is the tool builder's to say (tools.mjs). */
export type LaneProgressOptions = Omit<ProgressOptions, "keepsJourneyList">;

export interface ProgressPaths {
  controlRoot: string;
  eventPath: string;
  narrationPath?: string | null;
  initialChecklist?: readonly ChecklistItem[] | null;
  humanAuth?: ProgressHumanAuthPaths | null;
  terminal?: TerminalAnswerer | null;
  outputRoot?: string | null;
  caseId?: string | null;
}

export interface ProgressToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export declare function createProgressTools(options: ProgressOptions): {
  definitions: ProgressToolDefinition[];
  /** The text the agent reads back; a refused call rejects with the sentence it reads instead. */
  call(name: string, args: Record<string, unknown>): Promise<string>;
  /** Parks every wait still under way and writes no further event. */
  close(): void;
};

/** The options for a session, its record asked of the task API this runner was handed. */
export declare function progressOptions(paths: ProgressPaths): LaneProgressOptions & {
  knowledge: Record<string, string> | null;
  history: { root: string; outputRoot: string | null; caseId: string | null } | null;
  agentData: AgentDataCall | null;
};
