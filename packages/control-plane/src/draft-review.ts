/**
 * Pure rules for the drafts a walk delivers: which candidates are approved
 * Journeys rather than drafts, what the reader decides on, and what keeping
 * applies.
 *
 * Drafts are kept or discarded exactly as the walk delivered them; nothing
 * here rewrites one. The Journeys a change leaves as they are (unchanged) are
 * shown as approved, never decided on, and always kept. Archived candidates
 * are ignored. A hook scoped to a discarded draft is discarded with it: a
 * Suite refuses a hook whose scope names no Journey.
 */
import { journeyScriptBlocks } from "@shipbash/contracts/journey-contracts";
import { isPerJourneyRole } from "@shipbash/contracts/runtime/case-role-contract.mjs";

import type { ReviewCase } from "./journey-edit-review.ts";
import { type JourneyDefinition, sameJourneyDefinition } from "./store/journey-equivalence.ts";
import type { SuiteCaseDefinition } from "./types.ts";

interface DraftProposal {
  candidateDefinition: readonly SuiteCaseDefinition[];
}

/** The Suite name a create_suite lands on when the walk proposed none. */
export const DEFAULT_SUITE_NAME = "Production journeys";

/**
 * The candidates that are approved Journeys, not drafts. A Discovery's list
 * applies its live Cases from the Suite as it is (proposal-apply.ts), so
 * every candidate that is a live Case of the target Suite is approved
 * whatever the Suite says now; any other change's candidates count only
 * where they reproduce the live Case exactly.
 */
export function unchangedCandidateIds(
  proposal: DraftProposal,
  liveCases: ReadonlyArray<JourneyDefinition & { id: string; archived?: boolean | undefined }>,
  discovery: boolean,
): string[] {
  const live = new Map(liveCases.filter((entry) => !entry.archived).map((entry) => [entry.id, entry]));
  return proposal.candidateDefinition.flatMap((candidate) => {
    const current = candidate.id === undefined || candidate.archived ? undefined : live.get(candidate.id);
    return current && candidate.id !== undefined && (discovery || sameJourneyDefinition(candidate, current)) ? [candidate.id] : [];
  });
}

function isUnchanged(candidate: SuiteCaseDefinition, unchanged: ReadonlySet<string>): boolean {
  return candidate.id !== undefined && unchanged.has(candidate.id);
}

/** A draft that archives a live Case of the Suite when kept. */
function isRemoval(candidate: SuiteCaseDefinition, live: ReadonlySet<string>): boolean {
  return candidate.archived === true && candidate.id !== undefined && live.has(candidate.id);
}

/**
 * The candidates the reader decides on: every unarchived one the change
 * does not leave as it is, and every removal of a live Case.
 */
function decidableDrafts(
  proposal: DraftProposal,
  unchanged: ReadonlySet<string>,
  live: ReadonlySet<string>,
): SuiteCaseDefinition[] {
  return proposal.candidateDefinition.filter((candidate) => (
    !isUnchanged(candidate, unchanged) && (!candidate.archived || isRemoval(candidate, live))
  ));
}

/** The ids keep may name: every decidable draft, removals included. */
export function draftCaseIds(
  proposal: DraftProposal,
  unchangedCaseIds: readonly string[],
  liveCaseIds: ReadonlySet<string>,
): string[] {
  return decidableDrafts(proposal, new Set(unchangedCaseIds), liveCaseIds)
    .flatMap((candidate) => (candidate.id === undefined ? [] : [candidate.id]));
}

/**
 * What keeping applies, in the proposal's order: the unchanged Journeys, and
 * each draft keep names (every draft when keep is absent) unless its scope
 * names a discarded draft that adds a Case. A draft that is not kept leaves
 * the live Case it would change or remove as it is, and a live Case the
 * change does not mention stays too: only a kept removal archives one.
 * keptDrafts counts the drafts kept; zero means the reader kept nothing.
 * unknown lists the ids keep names that are no candidate of the proposal.
 */
export function keptCandidates(
  proposal: DraftProposal,
  unchangedCaseIds: readonly string[],
  keep: readonly string[] | null,
  liveCases: ReadonlyArray<SuiteCaseDefinition & { id: string; archived?: boolean | undefined }>,
): { cases: SuiteCaseDefinition[]; keptDrafts: number; unknown: string[] } {
  const unchanged = new Set(unchangedCaseIds);
  const live = new Map(liveCases.filter((entry) => !entry.archived).map((entry) => [entry.id, entry]));
  const drafts = decidableDrafts(proposal, unchanged, new Set(live.keys()));
  const named = keep ? new Set(keep) : null;
  const marked = (candidate: SuiteCaseDefinition) => named === null || (candidate.id !== undefined && named.has(candidate.id));
  const gone = new Set(drafts.flatMap((candidate) => (
    candidate.id !== undefined && !marked(candidate) && !live.has(candidate.id) ? [candidate.id] : []
  )));
  const kept = new Set(drafts.filter((candidate) => marked(candidate)
    && !(candidate.scopeCaseId != null && gone.has(candidate.scopeCaseId))));
  const cases = proposal.candidateDefinition.flatMap((candidate): SuiteCaseDefinition[] => {
    if (isUnchanged(candidate, unchanged) || kept.has(candidate)) return [candidate];
    const current = candidate.id === undefined ? undefined : live.get(candidate.id);
    return current ? [current] : [];
  });
  const ids = new Set(proposal.candidateDefinition.flatMap((candidate) => (candidate.id === undefined ? [] : [candidate.id])));
  return {
    cases: [...cases, ...[...live.values()].filter((current) => !ids.has(current.id))],
    keptDrafts: kept.size,
    unknown: (keep ?? []).filter((id) => !ids.has(id)),
  };
}

/**
 * The brief of a Suite walk that revises a proposal's drafts: the drafts as
 * the walk delivered them (a hook with its slot and scope), and the owner's
 * change. Its delivery replaces
 * the drafts, so it is told to deliver all of them again.
 */
export function followUpBrief(
  proposal: DraftProposal,
  unchangedCaseIds: readonly string[],
  liveCaseIds: ReadonlySet<string>,
  change: string,
): string {
  const drafts = decidableDrafts(proposal, new Set(unchangedCaseIds), liveCaseIds).map((draft) => (draft.archived ? `«${draft.title}» (removed)` : [
    `«${draft.title}» (${draftKind(proposal, draft)})`,
    ...journeyScriptBlocks(draft.steps, draft.checkpoints).map((block) => `${block.kind === "step" ? "-" : "- should:"} ${block.text}`),
  ].join("\n")));
  return [
    "Revise these proposed journeys with the change below and deliver them all again: what you deliver replaces them.",
    ...drafts,
    `The change: ${change}`,
  ].join("\n\n");
}

/** A Journey's category, or a hook's slot and the Journey it is around. */
function draftKind(proposal: DraftProposal, draft: SuiteCaseDefinition): string {
  const role = draft.role ?? "journey";
  if (role === "journey") return draft.category;
  if (draft.scopeCaseId == null) return isPerJourneyRole(role) ? `${role} hook around every Journey` : `${role} hook`;
  const scope = proposal.candidateDefinition.find((candidate) => candidate.id === draft.scopeCaseId);
  return `${role} hook around «${scope?.title ?? draft.scopeCaseId}»`;
}

function draftChange(entry: SuiteCaseDefinition & { id: string }, liveCaseIds: ReadonlySet<string>): ReviewCase["change"] {
  if (entry.archived) return "removed";
  return liveCaseIds.has(entry.id) ? "changed" : "added";
}

/**
 * A delivered proposal's drafts as an agent names them — list_journeys, the
 * report of the walk that drafted them, decide_drafts — by the rule its
 * review page decides on (api/views.ts): a Discovery's list leaves every live
 * Case it carries as it is.
 */
export function reviewDrafts(
  proposal: DraftProposal & { liveCases: ReadonlyArray<JourneyDefinition & { id: string; archived?: boolean | undefined }>; discovery: boolean },
): ReviewCase[] {
  const live = new Set(proposal.liveCases.filter((entry) => !entry.archived).map((entry) => entry.id));
  return draftReviewCases(proposal, unchangedCandidateIds(proposal, proposal.liveCases, proposal.discovery), live);
}

/**
 * The review of a walk's drafts: each decidable draft, "changed" when it
 * rewrites a live case, "removed" when it archives one (its script struck
 * through), and "added" otherwise, its whole script new.
 */
export function draftReviewCases(
  proposal: DraftProposal,
  unchangedCaseIds: readonly string[],
  liveCaseIds: ReadonlySet<string>,
): ReviewCase[] {
  return decidableDrafts(proposal, new Set(unchangedCaseIds), liveCaseIds).flatMap((entry): ReviewCase[] => (entry.id === undefined ? [] : [{
    id: entry.id,
    title: entry.title,
    category: entry.category,
    whyItMatters: entry.whyItMatters ?? null,
    role: entry.role ?? "journey",
    scopeCaseId: entry.scopeCaseId ?? null,
    change: draftChange({ ...entry, id: entry.id }, liveCaseIds),
    status: "ready",
    rows: journeyScriptBlocks(entry.steps, entry.checkpoints).map((block) => ({ ...block, mark: entry.archived ? "del" : "new" })),
  }]));
}
