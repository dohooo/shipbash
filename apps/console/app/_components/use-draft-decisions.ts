"use client";

import { useState } from "react";

import type { Proposal, ProposalCase } from "../../lib/web-client";
import { type HookRole, isHookRole, perJourneySlot } from "../_lib/case-slot";
import { keptCounts, type KeptCounts } from "../_lib/draft-kept";
import type { DraftCandidate, DraftDecision } from "./draft-review-parts";

/**
 * The decision state machine behind the draft review screen: which drafts are
 * kept, which one a change is being asked for, and the note being written
 * for it.
 *
 * It is a hook rather than state held in the screen because those three pieces
 * and everything derived from them are one thing — a key read off the wrong
 * list, or a discard that forgets the hooks scoped to its Journey, is a mark
 * landing on a draft the reader never touched. What is kept is decided again
 * by the server from keep, on the same rules; the marks here are what the
 * reader sees.
 */

function draftKey(candidate: ProposalCase, index: number): string {
  return candidate.id ?? `draft-${String(index)}`;
}

/**
 * Split the candidates for rendering: Journeys stay in the list, hooks move
 * to the Run order block, and a scoped per-journey hook also leaves a read-only
 * sticker keyed by the Journey it runs around. Rendering only — the decision
 * algorithms above still count over the whole set.
 */
function splitCandidates(candidates: readonly DraftCandidate[]): {
  journeyDrafts: DraftCandidate[];
  hookDrafts: DraftCandidate[];
  stickers: Map<string, { before: DraftCandidate[]; after: DraftCandidate[] }>;
} {
  const isHook = (candidate: DraftCandidate): candidate is DraftCandidate & { role: HookRole } =>
    candidate.role !== undefined && isHookRole(candidate.role);
  const journeyDrafts = candidates.filter((candidate) => !isHook(candidate));
  const hookDrafts = candidates.filter(isHook);
  const stickers = new Map<string, { before: DraftCandidate[]; after: DraftCandidate[] }>();
  for (const hook of hookDrafts) {
    if (!perJourneySlot(hook.role) || hook.scopeCaseId == null) continue;
    const slot = stickers.get(hook.scopeCaseId) ?? { before: [], after: [] };
    (hook.role === "before_each" ? slot.before : slot.after).push(hook);
    stickers.set(hook.scopeCaseId, slot);
  }
  return { journeyDrafts, hookDrafts, stickers };
}

/**
 * What the review body renders from and decides through. Every key and
 * decision here is derived from the whole candidate set, so the body can split
 * the drafts into two regions without a key ever coming off a shorter list.
 */
export interface DraftReviewControls {
  /** The whole unarchived set, in proposal order — what every key is counted against. */
  candidates: readonly DraftCandidate[];
  journeyDrafts: readonly DraftCandidate[];
  hookDrafts: readonly DraftCandidate[];
  stickers: Map<string, { before: DraftCandidate[]; after: DraftCandidate[] }>;
  changeRequestKey: string | null;
  instruction: string;
  staleInstruction: string | null;
  onDismissStaleInstruction: () => void;
  /** An approved Journey the change leaves as it is: shown, never decided on. */
  approvedOf: (candidate: DraftCandidate) => boolean;
  decisionOf: (candidate: DraftCandidate) => DraftDecision;
  /** Discarded along with the Journey it is scoped to, rather than on its own. */
  withJourneyOf: (candidate: DraftCandidate) => boolean;
  keyOf: (candidate: DraftCandidate) => string;
  onDecide: (candidate: DraftCandidate, decision: DraftDecision) => void;
  onToggleChangeRequest: (candidate: DraftCandidate) => void;
  onCancelChangeRequest: () => void;
  onInstructionChange: (value: string) => void;
}

/** The controls, plus the batch-level counts the screen's head and foot state. */
interface DraftDecisions extends DraftReviewControls {
  /** The decidable drafts: everything the change does not leave as it is. */
  drafts: readonly DraftCandidate[];
  keptDrafts: readonly DraftCandidate[];
  /** The kept drafts by id: what accept sends as keep. The server applies the same rules. */
  keep: string[];
  kept: KeptCounts;
  noneKept: boolean;
  setAll: (decision: DraftDecision) => void;
}

export function useDraftDecisions(proposal: Proposal): DraftDecisions {
  const [decisions, setDecisions] = useState<Record<string, DraftDecision>>({});
  const [changeRequestKey, setChangeRequestKey] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [staleInstruction, setStaleInstruction] = useState<string | null>(null);
  // Decisions are keyed by draft position when ids are absent, so a woken walk
  // that reorders or rewrites the drafts must clear them — a kept/discarded
  // mark reattaching to a different journey is the one mistake this screen
  // must never make.
  const [decidedRevision, setDecidedRevision] = useState(proposal.updatedAt);
  if (decidedRevision !== proposal.updatedAt) {
    setDecidedRevision(proposal.updatedAt);
    setDecisions({});
    if (changeRequestKey && instruction.trim()) setStaleInstruction(instruction);
    setChangeRequestKey(null);
    setInstruction("");
  }
  // The drafts the service decides on (draftCaseIds) and the approved
  // Journeys: an archived candidate is listed only as a removal it names.
  const candidates = proposal.candidateDefinition.filter((candidate) => (
    !candidate.archived || (candidate.id !== undefined && proposal.draftCaseIds.includes(candidate.id))
  ));
  // Each candidate's place in the whole set, taken once. The rendering split
  // hands these same objects back in two shorter lists, and a position counted
  // against one of those would key a mark onto a different draft.
  const positions = new Map(candidates.map((candidate, index) => [candidate, index]));
  const keyOf = (candidate: DraftCandidate) => {
    const index = positions.get(candidate);
    // Every caller renders a subset of `candidates`; anything else has no
    // place in the set, and there is no key worth guessing for it.
    if (index === undefined) throw new Error("This draft is not one of the proposal's candidates.");
    return draftKey(candidate, index);
  };
  const approved = (candidate: DraftCandidate) => candidate.id !== undefined && proposal.unchangedCaseIds.includes(candidate.id);
  const drafts = candidates.filter((candidate) => !approved(candidate));
  /** The mark the reader made on this draft itself, kept until they change it. */
  const markOf = (candidate: DraftCandidate): DraftDecision => decisions[keyOf(candidate)] ?? "kept";
  // A Journey's discard takes the hooks around it along: the store refuses
  // a hook whose scope names no Journey of the Suite, so a hook scoped
  // to a discarded draft goes with it and comes back with it.
  const discardedJourneyIds = new Set(drafts.flatMap((candidate) => (
    candidate.id !== undefined && markOf(candidate) === "discarded" ? [candidate.id] : []
  )));
  const withJourneyOf = (candidate: DraftCandidate) => candidate.scopeCaseId != null && discardedJourneyIds.has(candidate.scopeCaseId);
  const decisionOf = (candidate: DraftCandidate): DraftDecision =>
    (withJourneyOf(candidate) ? "discarded" : markOf(candidate));
  const keptDrafts = drafts.filter((candidate) => decisionOf(candidate) === "kept");
  return {
    ...splitCandidates(candidates),
    candidates,
    drafts,
    changeRequestKey,
    instruction,
    staleInstruction,
    kept: keptCounts(keptDrafts),
    keptDrafts,
    keep: keptDrafts.flatMap((candidate) => (candidate.id === undefined ? [] : [candidate.id])),
    noneKept: keptDrafts.length === 0,
    approvedOf: approved,
    decisionOf,
    keyOf,
    withJourneyOf,
    onCancelChangeRequest: () => setChangeRequestKey(null),
    onDismissStaleInstruction: () => setStaleInstruction(null),
    onDecide: (candidate, next) => setDecisions((current) => ({ ...current, [keyOf(candidate)]: next })),
    onInstructionChange: setInstruction,
    onToggleChangeRequest: (candidate) => {
      setInstruction(staleInstruction ?? "");
      setStaleInstruction(null);
      setChangeRequestKey(changeRequestKey === keyOf(candidate) ? null : keyOf(candidate));
    },
    setAll: (decision) => setDecisions(Object.fromEntries(
      drafts.map((candidate) => [keyOf(candidate), decision]),
    )),
  };
}
