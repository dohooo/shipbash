import type { decideEditsInput, verifyEditsInput } from "./edit-tools.mjs";

/** One tool as the runner defines it: a name, what the model reads, and a JSON Schema for its input. */
export interface ChatToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export declare const HOST_TOOL_NAMES: readonly string[];
/** Where the host gets a tool: its own executors, the GitHub source a turn reads, or nowhere. */
export declare function hostSource(name: string): "host" | "github" | null;

export declare function chatToolDefinitions(names: readonly string[]): ChatToolDefinition[];

/** What a walk is for: a check of how the product behaves, or one thing done in it. */
export declare const WALK_PURPOSES: readonly ["check", "action"];
export type WalkPurpose = (typeof WALK_PURPOSES)[number];

export type HostToolInput =
  | { tool: "start_verification"; input: { journeys?: string[] } }
  | {
      tool: "set_schedule";
      input: { cadence: "daily" | "cron" | "off"; localTime: string | null; cronExpression: string | null; timezone: string | null };
    }
  | { tool: "remove_from_suite"; input: { caseId: string } }
  | {
      tool: "decide_drafts";
      input: { walk: string; decision: "keep"; journeys?: string[]; run: boolean } | { walk: string; decision: "discard" };
    }
  | { tool: "verify_edits"; input: ReturnType<typeof verifyEditsInput> }
  | { tool: "decide_edits"; input: ReturnType<typeof decideEditsInput> }
  | { tool: "walk"; input: { title: string; purpose: WalkPurpose; brief: string } }
  | { tool: "tell_walk"; input: { walk: string; answer: string } }
  | { tool: "send_recording"; input: { journeyRun: string } };

export declare function hostToolInput(name: string, args: Record<string, unknown>): HostToolInput;

export interface ChatRecordToolIo {
  recordKnowledge(event: Record<string, unknown>): Promise<unknown>;
  nextRevision(): number;
}

export declare function runChatRecordTool(name: string, args: Record<string, unknown>, io: ChatRecordToolIo): Promise<string> | null;
