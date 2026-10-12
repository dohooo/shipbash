"use client";

import { HOOK_ROLES, caseSlotLabel, perJourneySlot } from "../_lib/case-slot";
import {
  type DraftCandidate,
  DraftDecisionActions,
  type DraftEntryControls,
  ChangeRequestPanel,
  DraftPreconditions,
  draftStepsSummary,
} from "./draft-review-parts";
import { journeyScriptBlocks } from "../../lib/journey-script";
import { DraftScript } from "./journey-draft-tab";
import type { DraftReviewControls } from "./use-draft-decisions";

/**
 * One Journey draft: what it proposes, the keep/discard mark, and the change
 * asked of it. A scoped lifecycle hook leaves a read-only sticker where it runs —
 * `before` above the body, `after` below the preconditions — but is decided
 * only in the Run order block, never here.
 */
function DraftCard({ candidate, controls, hooks }: {
  candidate: DraftCandidate;
  controls: DraftEntryControls;
  /** Scoped hooks that run around this Journey, shown read-only where they run. */
  hooks?: { before: DraftCandidate[]; after: DraftCandidate[] } | undefined;
}) {
  const { approved, decision, withJourney } = controls;
  return (
    <li data-decision={approved ? "approved" : decision}>
      {hooks?.before.map((hook) => <HookTab hook={hook} after={false} key={hook.id ?? hook.title} />)}
      <div className="draft-row">
        <div>
          <div className="draft-title">
            <strong>{candidate.title}</strong>
            {candidate.category ? <span className="journey-tag">{candidate.category}</span> : null}
            {candidate.repeat === "one_time" ? <span className="pend-chip one-time-chip">One-time · not in daily runs</span> : null}
            {approved ? <span className="journey-tag">Approved</span> : null}
            {withJourney ? <span className="journey-tag">Discarded with its Journey</span> : null}
            {candidate.ownerConfirmation === "pending" ? <span className="pend-chip">Needs your OK</span> : null}
          </div>
          <DraftScriptSummary candidate={candidate} />
          {candidate.whyItMatters ? <p>{candidate.whyItMatters}</p> : null}
        </div>
        <DraftDecisionActions controls={controls} />
      </div>
      <DraftPreconditions lines={candidate.preconditions} />
      {hooks?.after.map((hook) => <HookTab hook={hook} after key={hook.id ?? hook.title} />)}
      <ChangeRequestPanel title={candidate.title} controls={controls} />
    </li>
  );
}

/**
 * What a draft proposes, as one sentence. A draft that removes a live Journey
 * reads as the edit walk's review reads a removal: labelled, its script
 * struck through.
 */
function DraftScriptSummary({ candidate }: { candidate: DraftCandidate }) {
  // The only archived candidates the list holds are the removals the service names.
  if (!candidate.archived) return <p>{draftStepsSummary(candidate)}</p>;
  const rows = journeyScriptBlocks(candidate.steps, candidate.checkpoints).map((block) => ({ ...block, mark: "del" as const }));
  return (
    <div className="draft-removal">
      <span className="journey-tag">REMOVED BY THE WALK</span>
      <DraftScript rows={rows} />
    </div>
  );
}

/** A read-only sticker where a scoped hook runs: its timing and title, no controls. */
function HookTab({ hook, after }: { hook: DraftCandidate; after: boolean }) {
  return (
    <div className={`hk-line${after ? " after" : ""}`}>
      <em>{after ? "after" : "before"}</em>
      <b>{hook.title}</b>
      {hook.ownerConfirmation === "pending" ? <span className="hk-ok"><i aria-hidden />needs your OK</span> : null}
    </div>
  );
}

/** What a hook runs around: the one Journey it is scoped to, every Journey, or (per-run) nothing. */
function HookScope({ hook, candidates }: { hook: DraftCandidate; candidates: readonly DraftCandidate[] }) {
  if (hook.scopeCaseId != null) {
    const title = candidates.find((candidate) => candidate.id === hook.scopeCaseId)?.title ?? "one journey";
    return <span className="hk-scope">only around <b>{title}</b></span>;
  }
  if (hook.role !== undefined && perJourneySlot(hook.role)) {
    return <span className="hk-scope">runs around every journey</span>;
  }
  return null;
}

/** One hook in the Run order block: the only place it is kept, discarded, or asked to change. */
function HookEntry({ hook, candidates, controls }: {
  hook: DraftCandidate;
  candidates: readonly DraftCandidate[];
  controls: DraftEntryControls;
}) {
  const { approved, decision, withJourney } = controls;
  return (
    <div className="hk-entry" data-decision={approved ? "approved" : decision}>
      <div className="hk-entry-row">
        <div>
          <div className="hk-entry-head">
            <strong>{hook.title}</strong>
            <HookScope hook={hook} candidates={candidates} />
            {hook.repeat === "one_time" ? <span className="pend-chip one-time-chip">One-time · not in daily runs</span> : null}
            {withJourney ? <span className="journey-tag">Discarded with its Journey</span> : null}
            {hook.ownerConfirmation === "pending" ? <span className="pend-chip">Needs your OK</span> : null}
          </div>
          <DraftScriptSummary candidate={hook} />
          {hook.whyItMatters ? <p>{hook.whyItMatters}</p> : null}
        </div>
        <DraftDecisionActions controls={controls} />
      </div>
      <ChangeRequestPanel title={hook.title} controls={controls} />
      <DraftPreconditions lines={hook.preconditions} />
    </div>
  );
}

/**
 * The lifecycle hooks, declared once in run order: four slots
 * (before_all → before_each → after_each → after_all), each empty or holding
 * the hooks proposed for it. The count spans both blocks, but the decision
 * lives here alone.
 */
function RunOrderBlock({ hooks, candidates, controlsOf }: {
  hooks: readonly DraftCandidate[];
  candidates: readonly DraftCandidate[];
  controlsOf: (candidate: DraftCandidate) => DraftEntryControls;
}) {
  return (
    <div className="hk-head">
      <div className="hk-head-bar">
        <strong>Run order</strong>
        <span>{hooks.length} {hooks.length === 1 ? "hook" : "hooks"} · kept or discarded here only</span>
      </div>
      {HOOK_ROLES.map((role, position) => {
        const inSlot = hooks.filter((hook) => hook.role === role);
        return (
          <div className="hk-slot" data-empty={inSlot.length === 0} key={role}>
            <span className="hk-slot-name"><i>{position + 1}</i>{caseSlotLabel(role)}</span>
            {inSlot.length === 0 ? (
              <span className="hk-none">Nothing proposed — the run goes straight on.</span>
            ) : (
              <div>
                {inSlot.map((hook) => {
                  const controls = controlsOf(hook);
                  return <HookEntry hook={hook} candidates={candidates} controls={controls} key={controls.entryKey} />;
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The two decidable regions: the Run order block (hooks, when any) above the
 * list of Journey cards. The marks themselves belong to `useDraftDecisions`,
 * which derives every key from the whole candidate set — so this splits the
 * drafts into two regions without a key ever coming off a shorter list.
 *
 * A note asking for a change is the one thing the hook cannot hold: it is a
 * write, owned by the screen, and only its pending flag and trigger come
 * through here.
 */
export function DraftReviewBody({ review, sendingNote, onSendNote }: {
  review: DraftReviewControls;
  sendingNote: boolean;
  onSendNote: (candidate: DraftCandidate) => void;
}) {
  const controlsOf = (candidate: DraftCandidate) => entryControls(review, candidate, sendingNote, onSendNote);
  return (
    <>
      {review.hookDrafts.length > 0 ? (
        <RunOrderBlock hooks={review.hookDrafts} candidates={review.candidates} controlsOf={controlsOf} />
      ) : null}
      <ul className="drafts">
        {review.journeyDrafts.map((candidate) => {
          const controls = controlsOf(candidate);
          return (
            <DraftCard
              candidate={candidate}
              controls={controls}
              hooks={candidate.id != null ? review.stickers.get(candidate.id) : undefined}
              key={controls.entryKey}
            />
          );
        })}
      </ul>
    </>
  );
}

/** One draft's controls, read off the review for that draft. */
function entryControls(review: DraftReviewControls, candidate: DraftCandidate, sendingNote: boolean,
  onSendNote: (candidate: DraftCandidate) => void): DraftEntryControls {
  const entryKey = review.keyOf(candidate);
  return {
    entryKey,
    approved: review.approvedOf(candidate),
    decision: review.decisionOf(candidate),
    withJourney: review.withJourneyOf(candidate),
    requesting: review.changeRequestKey === entryKey,
    instruction: review.instruction,
    sendingNote,
    onDecide: (next) => review.onDecide(candidate, next),
    onToggleChangeRequest: () => review.onToggleChangeRequest(candidate),
    onCancelChangeRequest: review.onCancelChangeRequest,
    onInstructionChange: review.onInstructionChange,
    onSendNote: () => onSendNote(candidate),
  };
}
