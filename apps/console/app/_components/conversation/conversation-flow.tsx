"use client";

import type { ReactNode } from "react";
import { StickToBottom } from "use-stick-to-bottom";

import { ClosingPart } from "./closing-part";
import { LatestWhenShown } from "./latest-when-shown";
import { NarrativePart } from "./narrative-part";
import { QuestionPart } from "./question-part";
import { ToolPart } from "./tool-part";
import { UserMessagePart } from "./user-message-part";
import type { ConversationMessage, ConversationPart, ToolCallPart } from "../../_lib/conversation-parts";

interface ConversationFlowProps {
  messages: readonly ConversationMessage[];
  /** True while the agent is still writing: sticks to the bottom and shimmers the tail. */
  streaming?: boolean;
  /** Re-sends the user message whose delivery failed. */
  onRetryMessage?: ((messageId: string) => void) | undefined;
}

/**
 * Renders a conversation as its parts, in order. Every part type has exactly
 * one renderer, so adding a member to the catalog is adding a case here and a
 * module beside it — never a new branch inside an existing renderer.
 */
export function ConversationFlow({
  messages,
  streaming = false,
  onRetryMessage,
}: ConversationFlowProps) {
  const working = streaming ? streamingTailKey(messages) : null;
  return (
    <StickToBottom className="conv-flow" initial="smooth" resize="smooth" role="log">
      <StickToBottom.Content className="conv-flow-content" scrollClassName="conv-flow-scroll">
        {messages.map((message) => messageEntries({
          message,
          working,
                  onRetry: onRetryMessage ? () => onRetryMessage(message.id) : undefined,
        }))}
      </StickToBottom.Content>
      <LatestWhenShown />
    </StickToBottom>
  );
}

function partKey(message: ConversationMessage, index: number): string {
  return `${message.id}:${String(index)}`;
}

/**
 * One message's entries. Consecutive tool parts share one entry — the tool
 * renderer buckets them into per-class groups, and a group split across
 * entries would fold in two places at once.
 */
function messageEntries({ message, working, onRetry }: {
  message: ConversationMessage;
  working: string | null;
  onRetry?: (() => void) | undefined;
}): ReactNode[] {
  const entries: ReactNode[] = [];
  let batch: ToolCallPart[] = [];
  let batchKey = "";
  const flush = (): void => {
    if (batch.length === 0) return;
    entries.push(<div className="conv-entry" key={batchKey}><ToolPart parts={batch} /></div>);
    batch = [];
  };
  message.parts.forEach((part, index) => {
    if (part.type === "tool") {
      if (batch.length === 0) batchKey = partKey(message, index);
      batch.push(part);
      return;
    }
    flush();
    const key = partKey(message, index);
    entries.push(
      <div className="conv-entry" key={key}>
        {renderPart({ part, role: message.role, working: key === working, onRetry })}
      </div>,
    );
  });
  flush();
  return entries;
}

/**
 * The key of the part still being written — the last part of the last message,
 * and only when the agent is the one writing it. A milestone or a question is
 * never mid-word, and the reader's own message has already landed.
 */
function streamingTailKey(messages: readonly ConversationMessage[]): string | null {
  const last = messages.at(-1);
  if (last?.role !== "agent" || last.parts.length === 0) return null;
  const index = last.parts.length - 1;
  if (last.parts[index]?.type !== "narrative") return null;
  return partKey(last, index);
}

function renderPart({
  part,
  role,
  working,
  onRetry,
}: {
  part: Exclude<ConversationPart, { type: "tool" }>;
  role: ConversationMessage["role"];
  working: boolean;
  onRetry?: (() => void) | undefined;
}) {
  switch (part.type) {
    case "narrative":
      // The reader's own words arrive as narrative too; the role is what tells
      // the two voices apart, so neither needs a name tag.
      return role === "user"
        ? (
          <UserMessagePart
            markdown={part.markdown}
            state={part.delivery ?? "sent"}
            onRetry={part.delivery === "failed" ? onRetry : undefined}
          />
        )
        : <NarrativePart part={part} working={working} />;
    case "question":
      return <QuestionPart part={part} />;
    case "closing":
      return <ClosingPart part={part} />;
  }
}
