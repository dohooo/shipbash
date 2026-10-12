/**
 * The conversation-flow data contract.
 *
 * A conversation is a list of messages; each message is a list of parts, and
 * every part has exactly one renderer under `app/_components/conversation/`.
 * Hierarchy is carried by the part type, not by a label: narrative entries are
 * the unbordered body of the flow, and the one part that grows a border is the
 * one waiting on the reader.
 */

export type ConversationPart =
  | {
    type: "narrative";
    markdown: string;
    /**
     * Only user rows carry it, and only while the row is still local: absent
     * means the stream has the message. Sending shows as the dimmed bubble
     * alone — delivery has no receipt label — and failed keeps the words
     * beside a retry.
     */
    delivery?: "sending" | "failed";
  }
  | {
    type: "question";
    questionId: string;
    prompt: string;
    options: string[];
    allowFreeText: boolean;
    state: "pending" | "answered" | "skipped";
    answer?: { option?: string; freeText?: string; note?: string };
  }
  | {
    type: "tool";
    toolClass: "browser" | "read" | "knowledge" | "auth" | "terminal";
    verb: string;
    /** Already redacted and ≤60 characters — the adapter enforces the bound. */
    target: string;
    ms: number;
    state: "ok" | "fail";
    entryId?: string;
    /** Knowledge rows only: the in-place detail joined from the knowledge_entry event. */
    detail?: string;
    /** The step still running: rendered as the pulsing live row, never as a group row. */
    live?: boolean;
  }
  | {
    /**
     * The round's outcome as two sentences — the conclusion, then `Next · …`.
     * `working` shines the next sentence while it still waits on the reader.
     * At least one of `lede` and `next` is present.
     */
    type: "closing";
    lede?: string;
    next?: string;
    working?: boolean;
  };

export interface ConversationMessage {
  id: string;
  role: "agent" | "user" | "system";
  parts: ConversationPart[];
}

/** What the answer surface hands back. Options and free text are exclusive. */
export type QuestionAnswer = { option: string; note?: string } | { freeText: string } | { skipped: true };

export type QuestionPart = Extract<ConversationPart, { type: "question" }>;
export type ToolCallPart = Extract<ConversationPart, { type: "tool" }>;

/** Reads an answered question back as the single line to replay in the flow. */
export function answerValue(part: QuestionPart): string | null {
  const answer = part.answer;
  if (!answer) return null;
  return answer.freeText ?? answer.option ?? null;
}
