"use client";

import { useState, type ReactNode } from "react";

import type { ActivityDetail, ActivityEvent } from "../../lib/web-client";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "../../components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "../../components/ai-elements/message";
import { Suggestion, Suggestions } from "../../components/ai-elements/suggestion";
import { ChatComposer } from "./chat-composer";
import { LatestWhenShown } from "./conversation/latest-when-shown";

const narrativeKindLabels: Record<string, string> = {
  observation: "Observation",
  finding: "Finding",
  hypothesis: "Hypothesis",
  plan: "Plan",
};

interface AgentChatMessage {
  id: string;
  label: string | null;
  markdown: string;
  screenshotDataUrl: string | null;
  negative: boolean;
  /** True renders the message on the user's side of the conversation. */
  fromUser?: boolean;
}

export interface AgentChatSuggestion {
  label: string;
  run: () => void;
  disabled?: boolean;
  /** Renders as the emphasized primary action (e.g. Take control). */
  primary?: boolean;
}

/**
 * True when a body is the agent's structured result JSON, never chat prose.
 * Prefix-based on purpose: persisted bodies are often truncated, and a
 * truncated result no longer parses, so JSON.parse cannot be the gate.
 */
function structuredResultLikeBody(body: string): boolean {
  const head = body.slice(0, 400);
  if (!head.startsWith("{")) return false;
  return /"status"\s*:/.test(head)
    && (/"authState"\s*:/.test(head) || /"publicMarkdown"\s*:/.test(head) || /"summary"\s*:/.test(head));
}

/**
 * The reader's messages — the creation-time opening instruction and any later
 * steer — rejoining the conversation as their own bubbles after a reload. A
 * brief the host composed shows the reader's own words (displayText).
 */
function spokenTurnMessage(event: ActivityEvent, body: string): AgentChatMessage | null {
  if (event.safeData.event !== "steer_requested") return null;
  const displayText = event.safeData.displayText;
  return {
    id: event.id,
    label: null,
    markdown: typeof displayText === "string" && displayText.trim() ? displayText.trim() : body,
    screenshotDataUrl: null,
    negative: false,
    fromUser: true,
  };
}

/** Only a result the activity could not carry to the end reads as trouble. */
function negativeResult(resultKind: unknown): boolean {
  return resultKind === "needs_attention" || resultKind === "failed";
}

/**
 * A narrative beat and the evidence it carries. Only an inline image data URL
 * survives: a persisted URL that was truncated renders as a broken image.
 */
function narrativeMessage(event: ActivityEvent, body: string): AgentChatMessage | null {
  const { narrativeKind, screenshotDataUrl } = event.safeData;
  if (event.safeData.event !== "agent_narrative" || typeof narrativeKind !== "string") return null;
  return {
    id: event.id,
    label: narrativeKindLabels[narrativeKind] ?? null,
    markdown: body,
    screenshotDataUrl:
      typeof screenshotDataUrl === "string" && screenshotDataUrl.startsWith("data:image/")
        ? screenshotDataUrl
        : null,
    negative: false,
  };
}

/**
 * Projects persisted activity events into the agent's chat feed: narrative
 * beats, the final agent response, and lifecycle notes the user should read.
 * Everything is a message from the agent, in event order.
 */
function activityChatMessages(events: readonly ActivityEvent[]): AgentChatMessage[] {
  const messages: AgentChatMessage[] = [];
  for (const event of events) {
    const body = event.bodyMarkdown?.trim();
    if (!body) continue;
    if (structuredResultLikeBody(body)) continue;
    const eventName = event.safeData.event;
    // Candidate journeys render as structured cards, never as raw step text.
    if (eventName === "proposal_case") continue;
    const spoken = spokenTurnMessage(event, body);
    if (spoken) {
      messages.push(spoken);
      continue;
    }
    const narrative = narrativeMessage(event, body);
    if (narrative) {
      messages.push(narrative);
      continue;
    }
    if (eventName === "agent_output") {
      messages.push({ id: event.id, label: null, markdown: body, screenshotDataUrl: null, negative: false });
      continue;
    }
    if (event.kind === "lifecycle" && event.safeData.status === "waiting_for_auth") {
      messages.push({ id: event.id, label: event.label, markdown: body, screenshotDataUrl: null, negative: false });
      continue;
    }
    if (event.kind === "result") {
      // The final agent_output usually carries the full story; only surface a
      // result note when it adds something the agent has not already said.
      if (messages.some((message) => message.markdown === body)) continue;
      messages.push({
        id: event.id,
        label: event.label,
        markdown: body,
        screenshotDataUrl: null,
        negative: negativeResult(event.safeData.resultKind),
      });
    }
  }
  return messages;
}

/**
 * The activity page's chat feed: persisted events (the Edit run's opening
 * user bubble is its creation-time steer_requested event), the closing
 * summary and recovery notes a terminal run adds when the agent has not
 * already said them.
 */
export function activityChatFeed({ activity, terminal, cloudflareBlocked }: {
  activity: ActivityDetail;
  terminal: boolean;
  cloudflareBlocked: boolean;
}): AgentChatMessage[] {
  const messages = activityChatMessages(activity.events);
  const resultSummary = activity.result?.summary;
  if (terminal && resultSummary && !messages.some((message) => message.markdown === resultSummary)) {
    messages.push({
      id: `${activity.id}-result-summary`,
      label: null,
      markdown: resultSummary,
      screenshotDataUrl: null,
      negative: activity.status === "failed" || activity.status === "needs_attention",
    });
  }
  const recovery = !cloudflareBlocked ? activity.result?.recoveryAction : null;
  if (recovery && !messages.some((message) => message.markdown === recovery)) {
    messages.push({
      id: `${activity.id}-recovery`,
      label: "Next step",
      markdown: recovery,
      screenshotDataUrl: null,
      negative: false,
    });
  }
  return messages;
}

/**
 * Screenshot evidence hides itself when the persisted data URL is truncated
 * or otherwise undecodable — a broken image icon is worse than no image.
 */
function ChatScreenshot({ src }: { src: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  return (
    // An inline data: URI from the transcript: no remote asset for next/image to optimize,
    // and the broken-image fallback below needs the native element's onError.
    // biome-ignore lint/performance/noImgElement: an inline data: URI sized by .agent-chat-shot, with no dimensions to declare.
    <img
      className="agent-chat-shot"
      src={src}
      alt="Screenshot evidence"
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

/**
 * A hint line under the feed: the live status while the agent works, the
 * empty-state sentence before it has spoken. Plain text is the agent's own
 * pulse and gets the working treatment; a node the caller composed carries
 * its own.
 */
function ChatHint({ content, working }: { content: ReactNode; working: boolean }) {
  return <p className={`agent-chat-hint${working && typeof content === "string" ? " working" : ""}`}>{content}</p>;
}

/**
 * The bar under the feed: the activity's state next to the actions it calls
 * for. Nothing to say and nothing to do means no bar at all.
 */
function ChatActionBar({ suggestions, statusSlot }: {
  suggestions: readonly AgentChatSuggestion[];
  statusSlot: ReactNode;
}) {
  if (!suggestions.length && !statusSlot) return null;
  return (
    <div className="agent-chat-actionbar">
      {statusSlot ? <div className="agent-chat-actionbar-status">{statusSlot}</div> : null}
      <Suggestions className="agent-chat-suggestions">
        {suggestions.map((suggestion) => (
          <Suggestion
            key={suggestion.label}
            suggestion={suggestion.label}
            disabled={suggestion.disabled}
            className={suggestion.primary ? "primary" : undefined}
            onClick={() => suggestion.run()}
          />
        ))}
      </Suggestions>
    </div>
  );
}

export function ActivityChat({
  messages,
  suggestions,
  active,
  emptyHint,
  onSend,
  sendBusy,
  onStop = null,
  liveStatus = null,
  statusSlot = null,
}: {
  messages: readonly AgentChatMessage[];
  suggestions: readonly AgentChatSuggestion[];
  active: boolean;
  emptyHint: string;
  onSend: (text: string) => void;
  sendBusy: boolean;
  /** Cancels the running activity; wired to the input's Stop affordance. */
  onStop?: (() => void) | null;
  /**
   * One live line under the newest message while the agent works. It reflects
   * real event flow (action counts, current page), so the feed shows a pulse
   * even between the agent's narrated updates.
   */
  liveStatus?: ReactNode | null;
  /**
   * Activity status rendered inside the action bar, left-aligned against the
   * suggestions. Keeps the state and its required action in one glance when
   * they depend on each other (waiting for sign-in <-> Take control).
   */
  statusSlot?: ReactNode;
}) {
  return (
    <section className="agent-chat" aria-label="Agent conversation">
      <Conversation className="agent-chat-feed">
        <ConversationContent className="agent-chat-content">
          {messages.length === 0 ? <ChatHint content={(active && liveStatus) || emptyHint} working={active} /> : null}
          {messages.map((message, index) => (
            <Message from={message.fromUser ? "user" : "assistant"} key={message.id}>
              <MessageContent className={message.negative ? "agent-chat-negative" : undefined}>
                {message.label ? <span className="agent-chat-label">{message.label}</span> : null}
                <MessageResponse isAnimating={active && index === messages.length - 1}>
                  {message.markdown}
                </MessageResponse>
                {message.screenshotDataUrl ? (
                  <ChatScreenshot src={message.screenshotDataUrl} />
                ) : null}
              </MessageContent>
            </Message>
          ))}
          {(active || sendBusy) && liveStatus && messages.length > 0 ? (
            <ChatHint content={liveStatus} working />
          ) : null}
        </ConversationContent>
        <ConversationScrollButton />
        <LatestWhenShown />
      </Conversation>
      <ChatActionBar suggestions={suggestions} statusSlot={statusSlot} />
      <ChatComposer onSend={onSend} sendBusy={sendBusy} streaming={active} onStop={onStop} />
    </section>
  );
}
