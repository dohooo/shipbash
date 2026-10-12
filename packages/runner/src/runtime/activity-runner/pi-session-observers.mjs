// What the pi session broadcasts, observed for the harness: the live typing
// feed for viewers, the closing prose of each assistant message, the round's
// terminal error, and the sparse wait-progress events. Split from
// pi-agent-slot.mjs by responsibility — the slot runs the leg, this module
// listens to it.
import { agentServices } from "@shipbash/contracts/runtime/agent-model.mjs";
import { agentUsageCounts } from "@shipbash/contracts/runtime/agent-usage.mjs";

import { subscribeResponseFailure } from "../pi-sdk.mjs";
import { redactString } from "./redaction.mjs";
import { emit } from "./state.mjs";
import { looksLikeResultDocument } from "./pi-result.mjs";
import { WAIT_PROGRESS_EVENT_MINUTES, WAITING_TOOLS } from "./pi-tooling.mjs";

// Delta frames stay under the gateway's 4096-byte backpressure-drop floor:
// larger messages get silently shed on slow clients, and unlike video frames
// a dropped text frame is not replaced by the next one unless every frame
// carries the tail. So every frame is the accumulated tail, capped.
const DELTA_TAIL_LIMIT = 3_500;
const DELTA_FRAME_MIN_INTERVAL_MS = 125;

/** Saves each response's numeric usage before the container is removed. */
export function subscribeAgentUsage(session) {
  session.subscribe((event) => {
    if (event.type !== "message_end" || event.message?.role !== "assistant" || !event.message.usage) return;
    emit("lifecycle", "Agent usage recorded", {
      safeData: { event: "agent_usage", model: event.message.model, provider: event.message.provider,
        reasoningEffort: session.thinkingLevel, serviceTier: agentServices(process.env).model.serviceTier ?? undefined, ...agentUsageCounts(event.message.usage) },
    });
  });
}

/** The prose of a finished assistant message: its text parts, joined and trimmed. */
function assistantText(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .map((part) => (part && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}
/**
 * Whether the event carries an assistant message of the named envelope type.
 * The opening and the close of one message arrive in the same shape, so both
 * are recognised the same way.
 * @param {{ type?: string, message?: { role?: string } }} event
 * @param {string} type
 * @returns {boolean}
 */
function isAssistantMessageEvent(event, type) {
  return event.type === type && event.message?.role === "assistant";
}
/**
 * Streams assistant prose to the viewer socket as it is typed. Strictly
 * text_delta: thinking and toolcall deltas share the message_update envelope,
 * and pushing those would put the model's private reasoning on screen.
 * A message whose text opens with "{" is withheld — that is the closing
 * document taking shape, not prose.
 *
 * Each turn opens with one `thinking` frame: the model is being called and
 * nothing has been typed yet. It carries no words and is never persisted —
 * the transcript already holds the turn boundaries — so the console can show
 * that the agent is working without the reasoning itself. The first text
 * delta or the message's done frame ends it.
 */
export function subscribeAssistantDeltas(session, feed) {
  let seq = 0;
  let text = "";
  let lastPushAt = 0;
  session.subscribe((event) => {
    if (event.type === "turn_start") {
      feed.push({ type: "assistant_delta", seq: seq + 1, thinking: true });
      return;
    }
    if (isAssistantMessageEvent(event, "message_start")) {
      seq += 1;
      text = "";
      return;
    }
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      text += String(event.assistantMessageEvent.delta ?? "");
      if (text.trimStart().startsWith("{")) return;
      const now = Date.now();
      if (now - lastPushAt < DELTA_FRAME_MIN_INTERVAL_MS) return;
      lastPushAt = now;
      feed.push({ type: "assistant_delta", seq, text: redactString(text, Infinity).slice(-DELTA_TAIL_LIMIT) });
      return;
    }
    if (isAssistantMessageEvent(event, "message_end")) {
      const finalText = assistantText(event.message);
      if (finalText && !finalText.startsWith("{")) {
        feed.push({ type: "assistant_delta", seq, text: redactString(finalText, Infinity).slice(-DELTA_TAIL_LIMIT) });
      }
      feed.push({ type: "assistant_delta", seq, done: true });
    }
  });
}
/** Collects assistant prose as it lands; the closing document stays silent. */
/**
 * Holds the round's terminal error so the failure report can say WHY: the
 * generic "ended without delivering" line hides causes like an expired
 * sign-in that downstream recovery mapping knows how to translate. The error
 * is the last response's (pi-sdk.mjs subscribeResponseFailure).
 */
export function subscribeRoundError(session, holder) {
  const undelivered = holder.message;
  subscribeResponseFailure(session, (failure) => {
    holder.failed = failure !== null;
    holder.message = failure === null ? undelivered : `The agent round failed: ${failure}`;
  });
}
export function subscribeAssistantText(session, onAssistantText, record) {
  const updates = new Map();
  session.subscribe((event) => {
    // publish_update is also the agent's public prose. Record it only after
    // the tool succeeds; Discovery may then stop without repeating it in chat.
    if (event.toolName === "publish_update") {
      if (event.type === "tool_execution_start" && typeof event.args?.markdown === "string") {
        updates.set(event.toolCallId, event.args.markdown);
      }
      if (event.type === "tool_execution_end") {
        const markdown = updates.get(event.toolCallId);
        updates.delete(event.toolCallId);
        if (event.isError === false && markdown?.trim()) record(markdown);
      }
    }
  });
  session.subscribe((event) => {
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    const content = Array.isArray(event.message.content) ? event.message.content : [];
    const text = assistantText(event.message);
    if (!text) {
      // The handoff call ends the round: the message that makes it IS
      // the closing message. When it carries no prose, the record must not
      // fall back to an earlier interim narration — an empty record lets the
      // harness write the parked round's sentence instead.
      if (content.some((part) => part?.type === "toolCall" && part.name === "request_authentication")) record("");
      return;
    }
    record(text);
    if (!looksLikeResultDocument(text)) onAssistantText(text);
  });
}
/**
 * Surfaces a waiting tool's onUpdate ticks as sparse lifecycle events: the
 * first once the wait passes five minutes, then one every five. The event is
 * the reader-facing half; the per-minute ticks stay in pi's own stream.
 */
export function subscribeWaitProgress(session) {
  let lastReportedMinutes = 0;
  session.subscribe((event) => {
    if (event.type !== "tool_execution_update" || !WAITING_TOOLS.has(event.toolName)) return;
    const minutes = Number(event.partialResult?.details?.waitingMinutes ?? 0);
    if (minutes < WAIT_PROGRESS_EVENT_MINUTES || minutes % WAIT_PROGRESS_EVENT_MINUTES !== 0) return;
    if (minutes === lastReportedMinutes) return;
    lastReportedMinutes = minutes;
    emit("lifecycle", "Still waiting", {
      bodyMarkdown: event.toolName === "request_choice"
        ? `Still waiting on your answer — ${String(minutes)} minutes so far.`
        : `Still composing the Journey proposal — ${String(minutes)} minutes so far.`,
      safeData: { event: "tool_wait_progress", tool: event.toolName, waitingMinutes: minutes },
    });
  });
}
