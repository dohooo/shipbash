/**
 * What a walk leaves for the reader to keep or discard.
 *
 * An edit walk leaves the staged cases of the draft it walked, each diffed
 * against live and marked with how far the walk got, and every case the walk
 * added, changed or dropped beyond them. Keeping or discarding acts on the
 * draft, and only the draft's latest walk, while the draft is undecided, can
 * be kept.
 *
 * Any other walk leaves the drafts of the newest ready proposal it delivered:
 * the candidates keep may name, each as the walk delivered it. They can be
 * kept once the walk has finished (a woken Discovery delivers again) and
 * while no follow-up walk is revising them.
 */
import type { ActivityReviewView } from "@shipbash/contracts/api/view-types";
import { draftReviewCases } from "../draft-review.ts";
import { journeyDraftCases } from "../journey-edit-review.ts";
import type { StoreActivityDetail, StoreProposal } from "./gateways.ts";
import type { RouteContext } from "./route-support.ts";
import { liveCaseIds, type ProposalViewInputs, terminalActivityStatuses, unchangedCaseIds } from "./views.ts";

async function editWalkReview(
  { actor, options }: RouteContext,
  scope: { teamId: string; projectId: string },
  detail: StoreActivityDetail,
  draftId: string,
  proposals: readonly StoreProposal[],
): Promise<ActivityReviewView | null> {
  const [draft, walks] = await Promise.all([
    options.store.getProposal(actor, scope.teamId, scope.projectId, draftId),
    options.store.latestEditWalks(actor, scope.teamId, scope.projectId, [draftId]),
  ]);
  if (!draft?.journeyEditInstructions || !draft.targetSuiteId) return null;
  const suite = await options.store.getSuiteDetail(actor, scope.teamId, scope.projectId, draft.targetSuiteId);
  const terminal = terminalActivityStatuses.has(detail.activity.status);
  const cases = journeyDraftCases({
    draft,
    // A woken walk delivers again; its latest round is what keeping applies.
    final: proposals.filter((proposal) => proposal.kind === "change_suite").at(-1) ?? null,
    liveCases: (suite?.cases ?? []).map((entry) => ({ ...entry, archived: entry.archivedAt !== null })),
    terminal,
    events: detail.events,
  });
  const reason = editReviewReason({
    decided: draft.status !== "draft",
    latest: walks.get(draft.id)?.activityId === detail.activity.id,
    // Only an ended walk is kept (keep answers a running one WALK_NOT_FINISHED).
    walking: !terminal,
    // Keeping applies what the walk proved; an ended walk that proved no staged
    // edit has nothing to keep (keep answers it WALK_FAILED).
    provedNothing: terminal && !cases.some((entry) => entry.change === "staged" && entry.status === "ready"),
  });
  return {
    proposalId: draft.id,
    proposalUpdatedAt: draft.updatedAt,
    kind: "journey_edit",
    actionable: reason === null,
    reason,
    cases,
  };
}

function editReviewReason(state: { decided: boolean; latest: boolean; walking: boolean; provedNothing: boolean }): ActivityReviewView["reason"] {
  if (state.decided) return "EDITS_DECIDED";
  if (!state.latest) return "WALK_NOT_LATEST";
  if (state.walking) return "WALK_NOT_FINISHED";
  return state.provedNothing ? "NOTHING_PROVED" : null;
}

/**
 * The drafts of the walk's newest proposal; they are kept only once the walk
 * has ended, while no walk is working on them, and until they are decided.
 */
async function draftsReview(
  { actor, options }: RouteContext,
  scope: { teamId: string; projectId: string },
  detail: StoreActivityDetail,
  proposals: readonly StoreProposal[],
  inputs: ProposalViewInputs,
): Promise<ActivityReviewView | null> {
  // A woken discovery delivers again; its newest list is the one to decide.
  const proposal = proposals.at(-1);
  if (!proposal) return null;
  const review = { proposalId: proposal.id, proposalUpdatedAt: proposal.updatedAt, kind: "drafts" as const };
  // Kept, discarded, or replaced by a later walk's list: nothing is left to decide.
  if (proposal.status !== "ready") return { ...review, actionable: false, reason: "DRAFTS_DECIDED", cases: [] };
  const revising = (await options.store.latestEditWalks(actor, scope.teamId, scope.projectId, [proposal.id])).get(proposal.id);
  const settled = terminalActivityStatuses.has(detail.activity.status)
    && (!revising || terminalActivityStatuses.has(revising.status));
  return {
    ...review,
    actionable: settled,
    reason: settled ? null : "WALK_NOT_FINISHED",
    cases: draftReviewCases(
      proposal,
      unchangedCaseIds(proposal, inputs),
      liveCaseIds(proposal, inputs),
    ),
  };
}

export async function activityReview(
  context: RouteContext,
  scope: { teamId: string; projectId: string },
  detail: StoreActivityDetail,
  proposals: readonly StoreProposal[],
  inputs: ProposalViewInputs,
): Promise<ActivityReviewView | null> {
  // A walk started from a staging draft is an edit walk; one started from
  // drafts (a follow-up) delivers drafts of its own.
  const edit = detail.sourceProposalId
    ? await editWalkReview(context, scope, detail, detail.sourceProposalId, proposals)
    : null;
  return edit ?? draftsReview(context, scope, detail, proposals, inputs);
}
