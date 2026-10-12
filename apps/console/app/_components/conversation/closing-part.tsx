"use client";

import { ConversationMarkdown } from "./conversation-markdown";
import type { ConversationPart } from "../../_lib/conversation-parts";

type Closing = Extract<ConversationPart, { type: "closing" }>;

/**
 * The round's outcome as one paragraph, never a card: the conclusion sentence,
 * then `Next · …`, each the agent's own markdown. The next sentence shines
 * while it still waits on the reader. Counts are not repeated here — the tool
 * group heads already carry them — and there is no full-report link.
 */
export function ClosingPart({ part }: { part: Closing }) {
  return (
    <div className="conv-narrative" data-tone="finding">
      <div className="conv-narrative-body">
        <div className="x-out">
          {part.lede ? <ConversationMarkdown className="x-lede">{part.lede}</ConversationMarkdown> : null}
          {part.next
            ? (
              <ConversationMarkdown className={part.working ? "x-next working" : "x-next"}>
                {`**Next** · ${part.next}`}
              </ConversationMarkdown>
            )
            : null}
        </div>
      </div>
    </div>
  );
}
