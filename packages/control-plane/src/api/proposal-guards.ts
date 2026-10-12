/** The reads every proposal decision starts from, and what they refuse. */
import type { StoreProposal } from "./gateways.ts";
import { ApiError } from "./http.ts";
import type { RouteContext } from "./route-support.ts";

export async function readProposal(
  { actor, options }: RouteContext,
  scope: { teamId: string; projectId: string },
  proposalId: string,
): Promise<StoreProposal> {
  const proposal = await options.store.getProposal(actor, scope.teamId, scope.projectId, proposalId);
  if (!proposal) throw new ApiError(404, "PROPOSAL_NOT_FOUND", "Proposal was not found.");
  return proposal;
}

/**
 * What an edit walk delivered changes live journeys only through its staging
 * draft, where keeping applies just what the walk proved: it is never edited,
 * refined, followed up, kept or discarded on its own.
 */
export function refuseEditWalkResult(proposal: StoreProposal): void {
  if (proposal.editWalkDraftId) {
    throw new ApiError(409, "EDIT_WALK_RESULT", "An edit walk's result is kept or discarded with its staged edits.");
  }
}
