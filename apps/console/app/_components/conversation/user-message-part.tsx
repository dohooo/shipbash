"use client";

import { ConversationMarkdown } from "./conversation-markdown";

/**
 * The reader's own voice. The agent speaks on the left against a rail; you
 * speak on the right in a filled block with none. Position and fill carry the
 * difference, so neither side needs a name tag or an avatar — and the flow
 * never turns into a chat toy.
 */
export function UserMessagePart({
  markdown,
  state = "sent",
  onRetry,
}: {
  markdown: string;
  state?: "sent" | "sending" | "failed" | undefined;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <div className="conv-user" data-state={state}>
      <div className="conv-user-body">
        <ConversationMarkdown>{markdown}</ConversationMarkdown>
      </div>
      {/* Sending has no receipt label: the dimmed bubble is the whole state. */}
      {state === "failed"
        ? (
          <span className="conv-user-note conv-user-failed">
            Not delivered
            {onRetry
              ? <button className="conv-linkbutton" type="button" onClick={onRetry}>Retry</button>
              : null}
          </span>
        )
        : null}
    </div>
  );
}
