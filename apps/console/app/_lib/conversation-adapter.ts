/**
 * Projects a run's event stream into the conversation flow.
 *
 * The store keeps one flat, append-only event list; the reader sees a
 * conversation. This module, `conversation-adapter-fold.ts` beside it and the
 * round's ending in `conversation-adapter-closing.ts` are the only place that
 * translation happens, so a new event kind becomes a new part there and
 * nowhere else.
 *
 * Two rules are load-bearing. Message ids come from event ids, never from
 * position: the flow keys on them, and an id that shifts when an event lands
 * remounts the list and closes every card the reader had opened. And events
 * that carry operator diagnostics — a rejected knowledge entry names the
 * validator that rejected it — stay out of the conversation entirely; they
 * remain in the event trail where operators read them.
 */
import type { ActivityEvent } from "@/lib/web-client";
import {
  type ConversationFold,
  foldControlEvent,
  foldSpokenEvent,
  liveToolPart,
  type RunningTool,
  text,
} from "./conversation-adapter-fold";
import type { ConversationMessage, QuestionPart } from "./conversation-parts";

export function conversationFromActivityEvents(
  events: readonly ActivityEvent[],
  recoveryAction: string | null = null,
): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const running: RunningTool = { event: null };
  // Consecutive tool rows share one message, so the flow can bucket them into
  // per-class groups; any spoken part in between starts the next batch.
  let openTools: ConversationMessage | null = null;

  const fold: ConversationFold = {
    push: (event, part, role = "agent") => {
      openTools = null;
      messages.push({ id: event.id, role, parts: [part] });
    },
    pushTool: (event, part) => {
      if (!openTools) {
        openTools = { id: event.id, role: "agent", parts: [] };
        messages.push(openTools);
      }
      openTools.parts.push(part);
    },
    questions: new Map<string, QuestionPart>(),
    recoveryAction,
    running,
    spokenBodies: new Set<string>(),
    steeredKeys: new Set<string>(),
    wrapUpRequested: false,
  };

  for (const event of events) {
    const name = text(event.safeData.event);
    const body = text(event.bodyMarkdown);
    if (foldControlEvent(event, name, body, fold)) continue;
    foldSpokenEvent(event, name, body, fold);
  }
  if (running.event) {
    messages.push({ id: `${running.event.id}:live`, role: "agent", parts: [liveToolPart(running.event)] });
  }
  return messages;
}
