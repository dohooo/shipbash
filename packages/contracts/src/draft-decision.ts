/**
 * The reviews that wait for the owner's decision and the drafts each holds:
 * the one rule the console's Drafts banner, its Overview drafts row and its
 * Reviews list count by, and list_journeys lists and decide_drafts decides by
 * (control-plane agent-data/journeys.ts, store/draft-keep-for-job.ts), so
 * what the agent tells the owner is what the owner sees.
 */

interface ReviewOrigin {
	journeyEditInstructions?: Readonly<Record<string, string>> | null | undefined;
	editWalkDraftId?: string | null | undefined;
}

/**
 * A review decided as drafts, whatever it stands at now. A staging draft's
 * edits, and what an edit walk delivered for them, are kept or discarded with
 * the staged edits, never as drafts.
 */
export function decidedAsDrafts(proposal: ReviewOrigin): boolean {
	return !proposal.journeyEditInstructions && !proposal.editWalkDraftId;
}

/** A review still waiting for the owner. */
export function awaitsDecision(
	proposal: ReviewOrigin & { status: string },
): boolean {
	return (
		(proposal.status === "ready" || proposal.status === "draft") &&
		decidedAsDrafts(proposal)
	);
}

/**
 * The draft Journeys and hooks a review holds: every candidate it neither
 * archives nor carries as the Suite already has it (unchangedCaseIds).
 */
export function draftCandidates<
	Candidate extends { id?: string | undefined; archived?: boolean | undefined },
>(proposal: {
	candidateDefinition: readonly Candidate[];
	unchangedCaseIds: readonly string[];
}): Candidate[] {
	return proposal.candidateDefinition.filter(
		(candidate) =>
			!candidate.archived &&
			!(
				candidate.id !== undefined &&
				proposal.unchangedCaseIds.includes(candidate.id)
			),
	);
}
