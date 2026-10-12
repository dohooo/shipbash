"use client";

import { type ReactNode, useState } from "react";

import type { QuestionAnswer, QuestionPart } from "../../_lib/conversation-parts";

interface AnswerSurfaceProps {
  question: QuestionPart;
  onSubmit: (questionId: string, answer: QuestionAnswer) => void;
  /** True while the answer is in flight: the surface freezes but stays readable. */
  submitting?: boolean;
  leading?: ReactNode;
}

/** The free-text row's stand-in id inside the radiogroup. */
const FREE_PICK = "__free__";

// The reader's own words survive a re-render, an accidental unpick and a page
// reload: the draft lives outside React, keyed by the question it belongs to.
// Sending (or skipping) the question clears it.
function draftKey(questionId: string): string {
  return `shipbash-answer-draft:${questionId}`;
}

function readDraft(questionId: string): string {
  try {
    return window.sessionStorage.getItem(draftKey(questionId)) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(questionId: string, value: string): void {
  try {
    if (value) window.sessionStorage.setItem(draftKey(questionId), value);
    else window.sessionStorage.removeItem(draftKey(questionId));
  } catch {
    // Private-mode storage failures cost only the reload survival.
  }
}

function canSubmit(picked: string | null, freeText: string, submitting: boolean): boolean {
  return !submitting && (picked === FREE_PICK ? freeText.trim().length > 0 : picked !== null);
}

function selectedAnswer(option: string, note: string): QuestionAnswer {
  const trimmed = note.trim();
  return trimmed ? { option, note: trimmed } : { option };
}

function SendButton({ canSend, submitting, onSend }: {
  canSend: boolean; submitting: boolean;
  onSend: () => void;
}) {
  return <button className="button primary" type="button" disabled={!canSend} onClick={onSend}
    data-pending={submitting ? "true" : undefined} aria-busy={submitting}>
    {submitting ? <span className="conv-answer-spinner" aria-hidden="true" /> : null}
    {submitting ? "Submitting…" : "Answer and continue"}
  </button>;
}

/**
 * Replaces the composer while a question is open. One radiogroup holds every
 * way to answer: the offered options, and "Write my own answer" as the last
 * row — always on screen, its textarea open only while that row is picked, so
 * the way out of the offered answers never silently closes. A note under a
 * picked option is prose (a growing textarea), not a one-line field.
 *
 * Skip is a first-class answer. Nobody owes the agent a reply.
 */
export function AnswerSurface({ question, onSubmit, submitting = false, leading }: AnswerSurfaceProps) {
  const draftId = question.questionId;
  // A question re-opened to be changed arrives carrying its previous answer, so
  // the reader edits what they said rather than retyping it.
  const [askedId, setAskedId] = useState(question.questionId);
  const [picked, setPicked] = useState<string | null>(() => initialPick(question));
  const [note, setNote] = useState(question.answer?.note ?? "");
  const [freeText, setFreeText] = useState(() => question.answer?.freeText ?? readDraft(draftId));

  // The surface is reused across a run of questions, so a new question has to
  // arrive clean — a note left over from the last one would be attributed here.
  if (askedId !== question.questionId) {
    setAskedId(question.questionId);
    setPicked(initialPick(question));
    setNote(question.answer?.note ?? "");
    setFreeText(question.answer?.freeText ?? readDraft(draftId));
  }

  const freePicked = picked === FREE_PICK;
  const canSend = canSubmit(picked, freeText, submitting);

  function send() {
    if (!canSend) return;
    if (freePicked) {
      onSubmit(question.questionId, { freeText: freeText.trim() });
      return;
    }
    if (picked === null) return;
    onSubmit(question.questionId, selectedAnswer(picked, note));
  }

  return (
    <div className="conv-answer" data-submitting={submitting ? "true" : undefined} aria-busy={submitting}>
      <span className="conv-answer-head">
        <span className="conv-answer-title">
          {leading}
          <span className="conv-answer-label">Answer to continue</span>
        </span>
        <button
          className="conv-linkbutton"
          type="button"
          disabled={submitting}
          onClick={() => {
            onSubmit(question.questionId, { skipped: true });
          }}
        >
          Skip this question
        </button>
      </span>
      <p className="conv-answer-question">{question.prompt}</p>

      <div className="conv-answer-options" role="radiogroup" aria-label={question.prompt}>
        {question.options.map((option) => (
          <div className="conv-answer-option" data-picked={picked === option ? "true" : undefined} key={option}>
            {/* biome-ignore lint/a11y/useSemanticElements: a button-backed radiogroup styled as rows; the dot, the note and the free row's collapse all live on the button's own children. */}
            <button
              className="conv-answer-pick"
              type="button"
              role="radio"
              aria-checked={picked === option}
              disabled={submitting}
              onClick={() => { setPicked(option); }}
            >
              <span className="conv-answer-dot" aria-hidden="true" />
              <span>{option}</span>
            </button>
            {picked === option
              ? (
                <div className="conv-answer-note">
                  <textarea
                    value={note}
                    rows={2}
                    placeholder="Add a note (optional)"
                    aria-label="Add a note (optional)"
                    disabled={submitting}
                    onChange={(event) => { setNote(event.target.value); }}
                  />
                </div>
              )
              : null}
          </div>
        ))}
        {question.allowFreeText
          ? (
            <FreeAnswerRow
              picked={freePicked}
              text={freeText}
              submitting={submitting}
              onPick={() => { setPicked(FREE_PICK); }}
              onType={(value) => {
                // Typing IS picking: nobody types into an option they have
                // not chosen.
                setPicked(FREE_PICK);
                setFreeText(value);
                writeDraft(draftId, value);
              }}
            />
          )
          : null}
      </div>

      <span className="conv-answer-send">
        <SendButton canSend={canSend} submitting={submitting} onSend={send} />
      </span>
    </div>
  );
}

function FreeAnswerRow({
  picked,
  text,
  submitting,
  onPick,
  onType,
}: {
  picked: boolean;
  text: string;
  submitting: boolean;
  onPick: () => void;
  onType: (value: string) => void;
}) {
  return (
    <div className="conv-answer-option" data-free="true" data-picked={picked ? "true" : undefined}>
      {/* biome-ignore lint/a11y/useSemanticElements: the free-text row belongs to the same button-backed radiogroup as the options above it. */}
      <button
        className="conv-answer-pick"
        type="button"
        role="radio"
        aria-checked={picked}
        disabled={submitting}
        onClick={onPick}
      >
        <span className="conv-answer-dot" aria-hidden="true" />
        <span>Write my own answer</span>
        {!picked && text.trim() ? <span className="conv-answer-draft">Draft kept</span> : null}
      </button>
      <div className="conv-answer-free-body">
        <textarea
          value={text}
          rows={2}
          placeholder="Write your own answer…"
          aria-label="Write your own answer"
          disabled={submitting}
          onChange={(event) => { onType(event.target.value); }}
        />
      </div>
    </div>
  );
}

function initialPick(question: QuestionPart): string | null {
  if (typeof question.answer?.freeText === "string" && question.answer.freeText) return FREE_PICK;
  return question.answer?.option ?? null;
}
