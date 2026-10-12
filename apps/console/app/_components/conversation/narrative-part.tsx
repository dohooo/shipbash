"use client";

import { ConversationMarkdown } from "./conversation-markdown";
import type { ConversationPart } from "../../_lib/conversation-parts";

type Narrative = Extract<ConversationPart, { type: "narrative" }>;

/**
 * The body of the flow — dozens per exploration, so it carries no border, no
 * avatar and no bubble. A 3px rail and a line of text is the whole part; the
 * density of a long run depends on it staying this cheap.
 *
 * `working` is the streaming tail: the last thing the agent said while it is
 * still saying it, rendered with the shimmer instead of a spinner.
 */
export function NarrativePart({ part, working = false }: { part: Narrative; working?: boolean }) {
  return (
    <div className="conv-narrative" data-working={working ? "true" : undefined}>
      <div className="conv-narrative-body">
        <ConversationMarkdown streaming={working}>{part.markdown}</ConversationMarkdown>
      </div>
    </div>
  );
}
