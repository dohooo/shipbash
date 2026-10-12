import { activityKnowledgeSurface } from "@shipbash/contracts/runtime/discovery-surface.mjs";

import type { ActivityRuntimeInput, ActivityRuntimeSuite } from "./input.ts";
import type { ActivityProposalCandidate } from "./result-types.ts";

function assertChangedCaseCount(
	proposal: ActivityProposalCandidate,
	index: number,
): void {
	const changedCount = proposal.candidateDefinition.filter(
		(candidate) => candidate.change !== "unchanged",
	).length;
	if (changedCount < 1) {
		throw new Error(
			`proposals[${index}] must contain at least 1 changed Case.`,
		);
	}
}

function validateCreateSuiteSemantics(
	proposal: ActivityProposalCandidate,
	index: number,
): void {
	if (
		proposal.targetSuiteId !== null ||
		proposal.baseDefinitionRevision !== null ||
		!proposal.proposedSuiteName ||
		proposal.candidateDefinition.length < 1 ||
		proposal.candidateDefinition.some(
			(candidate) =>
				candidate.id !== null ||
				candidate.change !== "add" ||
				candidate.archived,
		)
	) {
		throw new Error(`proposals[${index}] has invalid create_suite semantics.`);
	}
}

function validateCandidateIdentity(
	proposal: ActivityProposalCandidate,
	target: ActivityRuntimeSuite,
	proposalIndex: number,
): void {
	const existingIds = new Set(target.cases.map((candidate) => candidate.id));
	const candidateIds = proposal.candidateDefinition
		.map((candidate) => candidate.id)
		.filter((candidateId): candidateId is string => candidateId !== null);
	if (new Set(candidateIds).size !== candidateIds.length) {
		throw new Error(`proposals[${proposalIndex}] contains duplicate Case ids.`);
	}
	for (const candidate of proposal.candidateDefinition) {
		if (
			candidate.change === "add"
				? candidate.id !== null
				: candidate.id === null || !existingIds.has(candidate.id)
		) {
			throw new Error(
				`proposals[${proposalIndex}] does not preserve Case identity.`,
			);
		}
		if (candidate.change === "archive" && !candidate.archived) {
			throw new Error(
				`proposals[${proposalIndex}] has an invalid archive change.`,
			);
		}
	}
	if ([...existingIds].some((id) => !candidateIds.includes(id))) {
		throw new Error(
			`proposals[${proposalIndex}] is not a complete resulting Suite definition.`,
		);
	}
}

function validateChangeSuiteSemantics(
	proposal: ActivityProposalCandidate,
	index: number,
	suites: ReadonlyMap<string, ActivityRuntimeSuite>,
	targets: Set<string>,
): void {
	const target = proposal.targetSuiteId
		? suites.get(proposal.targetSuiteId)
		: undefined;
	if (
		!target ||
		targets.has(target.id) ||
		proposal.baseDefinitionRevision !== target.definitionRevision ||
		proposal.proposedSuiteName !== null
	) {
		throw new Error(`proposals[${index}] has invalid change_suite semantics.`);
	}
	targets.add(target.id);
	validateCandidateIdentity(proposal, target, index);
}

function validateActivityKindSemantics(
	activity: ActivityRuntimeInput,
	proposals: readonly ActivityProposalCandidate[],
): void {
	// Discovery and a conversation keep one Journey list each.
	if (activityKnowledgeSurface(activity.kind).interacts) {
		// At most one, whatever the status: a woken conversational leg may
		// legally complete with nothing new to deliver, and a leg its time
		// budget ended keeps its saved list under the same roof (the runtime
		// result contract says the same). Either kind: a new Suite, or a
		// change_suite adding to the approved Suite the list was seeded from,
		// held to the Suite's own identity rules above.
		const invalid = proposals.length > 1 || proposals.some(
			(proposal) =>
				proposal.kind === "create_suite" &&
				proposal.candidateDefinition.length > 20,
		);
		if (invalid) {
			throw new Error(
				"Initial discovery may return at most one Proposal, a new Suite holding at most 20 User Journeys.",
			);
		}
	}
	if (activity.kind !== "generate_cases") return;
	if (
		activity.targetSuiteId === null &&
		proposals.some((proposal) => proposal.kind !== "create_suite")
	) {
		throw new Error(
			"New Suite generation may only return create_suite Proposals.",
		);
	}
	if (
		activity.targetSuiteId !== null &&
		proposals.some(
			(proposal) =>
				proposal.kind !== "change_suite" ||
				proposal.targetSuiteId !== activity.targetSuiteId,
		)
	) {
		throw new Error("Suite improvement may only change the targeted Suite.");
	}
}

export function validateActivityProposalSemantics(
	activity: ActivityRuntimeInput,
	proposals: readonly ActivityProposalCandidate[],
): void {
	const suites = new Map(activity.suites.map((suite) => [suite.id, suite]));
	const targets = new Set<string>();
	for (const [index, proposal] of proposals.entries()) {
		assertChangedCaseCount(proposal, index);
		if (proposal.kind === "create_suite") {
			validateCreateSuiteSemantics(proposal, index);
		} else {
			validateChangeSuiteSemantics(proposal, index, suites, targets);
		}
	}
	validateActivityKindSemantics(activity, proposals);
}
