"use client";

import { createContext, use, useEffect, useRef } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";

/** Whether the conversation is in sight; ConversationSplit says false while it is collapsed. */
export const ConversationShownContext = createContext(true);

/**
 * Inside a StickToBottom log: when the log is shown again after the page hid
 * it, it jumps to its latest entry, whatever the reader had scrolled to
 * before. Being shown from the start is not a return, so the log's own first
 * scroll is left alone.
 */
export function LatestWhenShown() {
  const shown = use(ConversationShownContext);
  const { scrollToBottom } = useStickToBottomContext();
  const wasShown = useRef(shown);
  useEffect(() => {
    if (shown && !wasShown.current) void scrollToBottom("instant");
    wasShown.current = shown;
  }, [shown, scrollToBottom]);
  return null;
}
