"use client";

/**
 * The conversation column of a Discovery run.
 *
 * Discovery talks back, so its column is not the one-way feed the other
 * activity kinds use: the agent can stop and ask, and the reader answers here,
 * because an answer only means anything beside the question that prompted it.
 * Stopping the run is not one of those: it acts on the run, so it lives with
 * the run's own controls under the browser.
 *
 * The composer has exactly one shape at a time. A pending question replaces
 * the text input outright — a card and a free-text box on screen together read
 * as two ways to say the same thing, and the reader picks neither.
 */
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

import { ChatComposer } from "./chat-composer";
import { ConversationFlow } from "./conversation/conversation-flow";
import { AnswerSurface } from "./conversation/answer-surface";
import { PresenceEyeSlot, usePresenceEyeSlotName } from "./presence-eye";
import type { ConversationMessage, QuestionAnswer, QuestionPart } from "../_lib/conversation-parts";
import { type ActivityDetail, webClient } from "@/lib/web-client";

interface DiscoveryConversationProps {
  projectId: string;
  activityId: string;
  messages: readonly ConversationMessage[];
  /** True while the run is live: the flow streams as it arrives. */
  active: boolean;
  /** The question the run is blocked on, as the server reads it; null when none is. */
  pendingQuestion: ActivityDetail["pendingQuestion"];
  emptyHint: string;
  /** Boot progress shown while the flow is still empty. */
  boot?: DiscoveryBootSignals;
  /** What the agent is typing right now, streamed ahead of the persisted event. */
  draft?: string | null;
  onSend: (text: string) => void;
  /** Re-sends the local steer row whose delivery failed. */
  onRetryMessage?: ((messageId: string) => void) | undefined;
  sendBusy: boolean;
  /** Re-reads the run once an answer or a wrap-up has been accepted. */
  onSettled: () => void;
  /** Attention-driven actions, shown above the composer. */
  suggestions?: readonly { label: string; run: () => void; disabled?: boolean; primary?: boolean }[];
  liveStatus?: ReactNode | null;
  /** The line that stands for the run once it has completed; it is not working, so it reads plain. */
  finishedHint?: string | null;
  /** True while the reader's Stop is in flight or on the record, from the
   *  page that owns the stop control. The composer closes: the round is
   *  ending, and a message now would land on a run that is stopping. The
   *  flow's own "Stop requested" line is the wrap_up_requested event's. */
  wrappingUp?: boolean;
}

/** Which boot stages the run has really reached, read off the live detail. */
interface DiscoveryBootSignals {
  /** A leg is running: the sandbox is up (first events or a running status). */
  sandboxUp: boolean;
  /** The browser announced its live stream. */
  browserReady: boolean;
}

export const COLD_BOOT: DiscoveryBootSignals = { sandboxUp: false, browserReady: false };

/**
 * A just-created run has no events for the seconds its runtime takes to boot,
 * and unmounting the flow would collapse the column's geometry — the composer
 * loses its flex spacer and its bottom anchor. The flow stays mounted with
 * the boot stages the run has really reached; the reader's own instruction is
 * a real steer_requested event from the moment the run was created.
 */
/**
 * The boot rows stay in the list once real events land — the reader watched
 * the sandbox wake and the browser start, and those lines are part of the
 * story, not a placeholder to be swapped out.
 */
export function openingFlow(boot: DiscoveryBootSignals): ConversationMessage[] {
  const stages = ["Waking the sandbox…"];
  if (boot.sandboxUp) stages.push("Sandbox up — starting the browser…");
  if (boot.browserReady) stages.push("Browser ready — heading to the product…");
  return stages.map((markdown, index): ConversationMessage => ({
    id: `opening-boot-${String(index)}`,
    role: "agent",
    parts: [{ type: "narrative", markdown }],
  }));
}

/**
 * The rendered flow: inherited history first, then the run's own rows — the
 * reader's opening instruction arrives as a real steer_requested event, so it
 * is never the missing row.
 */
function conversationBody(input: {
  messages: readonly ConversationMessage[];
  active: boolean;
  boot: DiscoveryBootSignals;
  draft: string | null | undefined;
}): ConversationMessage[] {
  const own = [...input.messages];
  // Boot rows lead the flow and STAY once events arrive — appending, never
  // replacing: the list grows in one place from "Waking the sandbox…" on.
  // They slot in after the reader's opening instruction, whose event is
  // written at creation and therefore leads the message list.
  if (input.active) {
    let lead = 0;
    while (own[lead]?.role === "user") lead += 1;
    own.splice(lead, 0, ...openingFlow(input.boot));
  }
  const draft = input.active && input.draft?.trim() ? input.draft.trim() : null;
  // Once the persisted event lands with the same words, the draft yields —
  // suppression by text keeps the finished message from flickering out.
  if (draft && !recentNarrativeMatches(own, draft)) {
    own.push({ id: "assistant-draft", role: "agent", parts: [{ type: "narrative", markdown: draft }] });
  }
  return own;
}

/**
 * True when one of the last few rows already carries this prose. The draft
 * streams as an accumulated TAIL (long messages are windowed to their last
 * few thousand characters), so a persisted body that ends with the draft is
 * the same message — exact equality alone showed the pair as two bubbles.
 */
function recentNarrativeMatches(messages: readonly ConversationMessage[], text: string): boolean {
  // The whole flow, not a tail window: tool groups, knowledge and questions
  // interleave between narratives, so the draft's persisted twin can sit many
  // rows up — a bounded window left the draft echoing an old message at the
  // bottom of the column.
  return messages.some((message) => message.parts.some(
    (part) => part.type === "narrative" && part.markdown.trim().endsWith(text),
  ));
}

/**
 * The status line above the composer. An open answer card owns the eye slot;
 * keep this line only when it has actual status text in that case.
 */
function StatusHint({
  active,
  liveStatus,
  finishedHint,
  answerVisible,
}: {
  active: boolean;
  liveStatus: ReactNode;
  finishedHint: string | null;
  answerVisible: boolean;
}) {
  const slotName = usePresenceEyeSlotName();
  const eyeAtComposer = !answerVisible && slotName === "composer";
  const showLiveStatus = Boolean(active && liveStatus);
  const line = showLiveStatus ? liveStatus : active ? null : finishedHint;
  if (!line && !eyeAtComposer) return null;
  return (
    <p className={`agent-chat-hint${showLiveStatus && typeof liveStatus === "string" ? " working" : ""}`}>
      {!answerVisible ? <PresenceEyeSlot name="composer" /> : null}
      {line ? <span className="hint-copy">{line}</span> : null}
    </p>
  );
}

/**
 * The live question and its answer. The surface answers the question the
 * server says the run waits on (activity.pendingQuestion), never a card left
 * over from history — and an answer that went through takes its card with it
 * at once: the read that settles it lands later, and the card stood there in
 * between.
 */
function useQuestionAnswer({ projectId, activityId, pendingQuestion, onSettled }: {
  projectId: string;
  activityId: string;
  pendingQuestion: ActivityDetail["pendingQuestion"];
  onSettled: () => void;
}) {
  const [answered, setAnswered] = useState<string | null>(null);
  const answer = useMutation({
    mutationFn: (input: { questionId: string; answer: QuestionAnswer }) => webClient.answerActivityQuestion(
      projectId,
      activityId,
      "skipped" in input.answer
        ? { questionId: input.questionId, skipped: true }
        : "freeText" in input.answer
          ? { questionId: input.questionId, freeText: input.answer.freeText }
          : {
              questionId: input.questionId,
              option: input.answer.option,
              ...(input.answer.note ? { note: input.answer.note } : {}),
            },
    ),
    onSuccess: (_result, input) => setAnswered(input.questionId),
    onSettled: () => onSettled(),
  });
  // The question to answer now, or none.
  const question: QuestionPart | null = pendingQuestion && pendingQuestion.questionId !== answered
    ? { type: "question", ...pendingQuestion, state: "pending" }
    : null;
  return { answer, question };
}

/** The composer's one shape: the question the live run is blocked on, or free text. */
function ComposerSlot({ question, answering, onAnswer, onSend, sendBusy, wrappingUp, leading }: {
  question: QuestionPart | null;
  answering: boolean;
  onAnswer: (questionId: string, answer: QuestionAnswer) => void;
  onSend: (text: string) => void;
  sendBusy: boolean;
  /** The run is being told to stop: the text box takes nothing for it. */
  wrappingUp: boolean;
  leading?: ReactNode;
}) {
  const busy = sendBusy || wrappingUp;
  if (question) return <AnswerSurface question={question} submitting={answering} onSubmit={onAnswer} leading={leading} />;
  return <ChatComposer onSend={onSend} sendBusy={busy} />;
}

export function DiscoveryConversation({
  projectId,
  activityId,
  messages,
  active,
  pendingQuestion,
  emptyHint,
  boot = COLD_BOOT, draft,
  onSend,
  onRetryMessage,
  sendBusy,
  onSettled,
  liveStatus = null,
  finishedHint = null,
  suggestions = [],
  wrappingUp = false,
}: DiscoveryConversationProps) {
  const { answer, question } = useQuestionAnswer({ projectId, activityId, pendingQuestion, onSettled });
  const flow = conversationBody({ messages, active, boot, draft });
  const failure = answer.error;
  const emptyState = flow.length === 0;
  const answerVisible = question !== null;

  return (
    <section className="agent-chat" aria-label="Agent conversation">
      {emptyState ? (
        <p className="agent-chat-hint">
          {!answerVisible ? <PresenceEyeSlot name="composer" /> : null}
          <span className="hint-copy">{emptyHint}</span>
        </p>
      ) : (
        <ConversationFlow messages={flow} streaming={active} onRetryMessage={onRetryMessage} />
      )}
      {emptyState ? null : <StatusHint active={active} liveStatus={liveStatus} finishedHint={finishedHint} answerVisible={answerVisible} />}
      {failure ? (
        <p className="agent-chat-hint" role="alert">
          <span className="hint-copy">{failure instanceof Error ? failure.message : "That did not go through. Try again."}</span>
        </p>
      ) : null}
      {suggestions.length ? (
        <div className="agent-chat-actionbar">
          <div className="agent-chat-suggestions">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.label}
                type="button"
                disabled={suggestion.disabled}
                className={suggestion.primary ? "primary" : undefined}
                onClick={() => suggestion.run()}
              >
                {suggestion.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <ComposerSlot
        question={question}
        answering={answer.isPending}
        onAnswer={(questionId, given) => answer.mutate({ questionId, answer: given })}
        onSend={onSend}
        sendBusy={sendBusy}
        wrappingUp={wrappingUp}
        leading={<PresenceEyeSlot name="composer" />}
      />
    </section>
  );
}
