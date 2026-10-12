/**
 * The session-local half of the steer channel.
 *
 * A steer folds into the running pass, so the reader's bubble must land before
 * the server speaks. These helpers project the steers a page sent this session
 * onto the conversation flow, and read the stream's echoes back out of the
 * event list to know when the local copy can retire.
 */
import type { ActivityEvent } from "@/lib/web-client";
import { conversationFromActivityEvents } from "./conversation-adapter";
import type { ConversationMessage } from "./conversation-parts";

/** A steer the reader sent this session, tracked until the stream echoes it. */
export interface PendingSteer {
  clientKey: string;
  message: string;
  state: "sending" | "sent" | "failed";
}

export const localSteerId = (clientKey: string): string => `steer-local-${clientKey}`;

/** The conversation with this session's steers projected in. */
export function steeredConversation(
  steers: readonly PendingSteer[],
  events: readonly ActivityEvent[],
  recoveryAction: string | null = null,
): { messages: ConversationMessage[]; steering: boolean } {
  const { rows, steering, hiddenEchoIds } = localSteerFlow(steers, events);
  return {
    messages: [
      ...conversationFromActivityEvents(events, recoveryAction)
        .filter((message) => !hiddenEchoIds.has(message.id)),
      ...rows,
    ],
    steering,
  };
}

/**
 * The reader's steers still ahead of the stream, as flow rows. The server's
 * steer_requested echo replaces the optimistic bubble — matched by clientKey —
 * and the hint keeps saying "Steering…" until the run acks with steer_folded
 * or the send fails.
 *
 * A FAILED local row outranks its own echo: the echo proves the words reached
 * the record, the failed state says they never reached the agent, and the row
 * carrying the Retry is the one telling the truth — so the echoed event rows
 * for those clientKeys come back as hiddenEchoIds for the caller to drop.
 */
function localSteerFlow(
  steers: readonly PendingSteer[],
  events: readonly ActivityEvent[],
): { rows: ConversationMessage[]; steering: boolean; hiddenEchoIds: Set<string> } {
  const failedKeys = new Set(
    steers.filter((entry) => entry.state === "failed").map((entry) => entry.clientKey),
  );
  const echoed = new Set<string>();
  const folded = new Set<string>();
  const hiddenEchoIds = new Set<string>();
  for (const event of events) {
    const key = event.safeData.clientKey;
    if (typeof key !== "string") continue;
    if (event.safeData.event === "steer_requested") {
      echoed.add(key);
      if (failedKeys.has(key)) hiddenEchoIds.add(event.id);
    }
    // A deferral settles the send the same way a fold does: the words are
    // recorded and owed to the next wake, so "Steering…" must let go.
    if (event.safeData.event === "steer_folded" || event.safeData.event === "steer_deferred") folded.add(key);
  }
  return {
    rows: steers
      .filter((entry) => entry.state === "failed" || !echoed.has(entry.clientKey))
      .map((entry): ConversationMessage => ({
        id: localSteerId(entry.clientKey),
        role: "user",
        parts: [{
          type: "narrative",
          markdown: entry.message,
          ...(entry.state === "sent" ? {} : { delivery: entry.state }),
        }],
      })),
    steering: steers.some((entry) => entry.state !== "failed" && !folded.has(entry.clientKey)),
    hiddenEchoIds,
  };
}
