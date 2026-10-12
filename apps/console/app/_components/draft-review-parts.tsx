"use client";

import { journeyStepInstruction, type ProposalCase, type Proposal } from "../../lib/web-client";
import { keptPhrase, type KeptCounts } from "../_lib/draft-kept";

/** A candidate as the proposal view carries it: the role fields and a proposed hook's confirmation ride along. */
export type DraftCandidate = Proposal["candidateDefinition"][number];

/** What a draft proposes, as one sentence, in script order. */
export function draftStepsSummary(candidate: ProposalCase): string {
  const steps = typeof candidate.steps === "string"
    ? candidate.steps.split("\n")
    : candidate.steps.map(journeyStepInstruction);
  return steps.map((step) => step.trim()).filter(Boolean).join(" → ");
}

export type DraftDecision = "kept" | "discarded";

/** One decidable draft's controls, already resolved for that draft. */
export interface DraftEntryControls {
  /** The draft's key among the whole candidate set. */
  entryKey: string;
  /** An approved Journey the change leaves as it is: shown, not decided on. */
  approved: boolean;
  decision: DraftDecision;
  /** A hook discarded along with the Journey it is scoped to: decided by it, not here. */
  withJourney: boolean;
  /** This draft's change note is the one open. */
  requesting: boolean;
  instruction: string;
  sendingNote: boolean;
  onDecide: (decision: DraftDecision) => void;
  onToggleChangeRequest: () => void;
  onCancelChangeRequest: () => void;
  onInstructionChange: (value: string) => void;
  onSendNote: () => void;
}

/** What the walk assumes is already true — the recipient of anything it sends, above all. */
export function DraftPreconditions({ lines }: { lines: readonly string[] | undefined }) {
  if (!lines?.length) return null;
  return (
    <div className="preconditions">
      <span className="preconditions-kicker">Preconditions</span>
      <ul>
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </div>
  );
}

/** Keep, discard or ask for changes, for one decidable draft — shared by a Journey card and a hook's Run-order entry. */
export function DraftDecisionActions({ controls }: { controls: DraftEntryControls }) {
  const { approved, decision, withJourney, onToggleChangeRequest, onDecide } = controls;
  if (approved) return null;
  return (
    <div className="draft-actions">
      <button className="button quiet" type="button" onClick={onToggleChangeRequest}>
        Ask for changes
      </button>
      <button
        aria-pressed={decision === "kept"}
        className="button quiet"
        data-choice="kept"
        disabled={withJourney}
        type="button"
        onClick={() => onDecide("kept")}
      >
        Keep
      </button>
      <button
        aria-pressed={decision === "discarded"}
        className="button quiet danger"
        data-choice="discarded"
        disabled={withJourney}
        type="button"
        onClick={() => onDecide("discarded")}
      >
        Discard
      </button>
    </div>
  );
}

/**
 * The change asked of one draft, open only while it is being written. The
 * note goes to a walk: nothing rewrites a draft without walking it.
 */
export function ChangeRequestPanel({ title, controls }: { title: string; controls: DraftEntryControls }) {
  const { requesting, instruction, sendingNote, onCancelChangeRequest, onInstructionChange, onSendNote } = controls;
  if (!requesting) return null;
  return (
    <div className="draft-edit">
      <span className="kicker">What should change</span>
      <textarea
        aria-label={`What should change about ${title}`}
        maxLength={1_000}
        placeholder="Step 3 should pay with the sandbox card instead of the saved one."
        value={instruction}
        onChange={(event) => onInstructionChange(event.target.value)}
      />
      <div className="draft-edit-foot">
        <span>ShipBash walks the product again with your note and delivers new drafts to review.</span>
        <span className="actions-row">
          <button className="button quiet" type="button" onClick={onCancelChangeRequest}>Cancel</button>
          <button
            className="button primary"
            type="button"
            disabled={sendingNote || !instruction.trim()}
            onClick={onSendNote}
          >
            {sendingNote ? "Sending…" : "Walk it again"}
          </button>
        </span>
      </div>
    </div>
  );
}

export function DraftReviewHead() {
  return (
    <header className="review-head">
      <p className="eyebrow">Drafts from the last exploration</p>
      <h1>Keep what matters, drop the rest</h1>
      <p>These are proposals, not promises. Five minutes here decides what ShipBash guards on every run.</p>
    </header>
  );
}

export function DraftReviewToolbar({ keptCount, total, noneKept, onSetAll }: {
  keptCount: number;
  total: number;
  noneKept: boolean;
  onSetAll: (decision: DraftDecision) => void;
}) {
  return (
    <div className="review-toolbar">
      <span>{keptCount} of {total} kept</span>
      {/* Both are selections, not commitments: nothing is written until the footer button is pressed. */}
      <div className="actions-row">
        <button
          aria-pressed={noneKept}
          className="button"
          data-choice="discarded"
          type="button"
          onClick={() => onSetAll("discarded")}
        >
          Discard all
        </button>
        <button
          aria-pressed={keptCount === total}
          className="button"
          data-choice="kept"
          type="button"
          onClick={() => onSetAll("kept")}
        >
          Keep all
        </button>
      </div>
    </div>
  );
}

export function DraftReviewFoot({ noneKept, confirming, discarding, total, kept, kind, onCommit }: {
  noneKept: boolean;
  confirming: boolean;
  discarding: boolean;
  total: number;
  kept: KeptCounts;
  kind: Proposal["kind"];
  onCommit: () => void;
}) {
  return (
    <footer className="review-foot">
      {/* One button, always saying what it is about to do: adopting a new
          Suite starts a baseline walk now; adding to an approved Suite joins
          its schedule and a verification of it starts; with nothing kept the
          only thing left to confirm is dropping the batch. */}
      <button
        className={`button primary${noneKept ? " danger" : ""}`}
        type="button"
        disabled={confirming || discarding}
        onClick={onCommit}
      >
        {confirming ? "Adding…" : discarding ? "Discarding…"
          : noneKept ? `Discard all ${String(total)}`
            : kind === "change_suite" ? `Add ${keptPhrase(kept)} and verify`
              : `Add ${keptPhrase(kept)} and verify now · ~3 min`}
      </button>
    </footer>
  );
}
