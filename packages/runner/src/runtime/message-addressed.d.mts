import type { AgentServices } from "@shipbash/contracts/runtime/agent-model.mjs";
import type { SlackLinePrevious, ThreadLine } from "@shipbash/contracts/slack-line";

/** The message: who wrote it, its words, and whether its author has addressed ShipBash in this conversation before. */
export interface ThreadMessage {
  from: string;
  userId: string;
  text: string;
  addressedBefore: boolean;
}

export interface ThreadFacts {
  previous: SlackLinePrevious | null;
  sinceShipBash: { lines: number; byOthers: number } | null;
}

export interface AddressedJudgment {
  decision: "act" | "aside";
  rule: string;
  nouls: Record<string, number>;
  ms: number;
  error?: string;
}

export declare function threadFacts(thread: ReadonlyArray<ThreadLine>, message: ThreadMessage): ThreadFacts;

export declare function judgeAddressed(
  input: { thread: ReadonlyArray<ThreadLine>; message: ThreadMessage; facts: ThreadFacts },
  options: { jev: AgentServices["jev"]; fetchImpl?: typeof fetch },
): Promise<AddressedJudgment>;
