import type {
	ActivityAttentionCode,
	SuiteCaseRepeat,
	SuiteCaseRole,
} from "@shipbash/contracts/database-contract-types";
import type { OwnerConfirmation } from "@shipbash/contracts/runtime/case-role-contract.mjs";

export type ActivityProposalChange = "add" | "update" | "archive" | "unchanged";

export interface ActivityProposalCandidateDefinition {
	id: string | null;
	title: string;
	steps: string[];
	category: string;
	/** afterStep anchors the goal after a `step-<n>` id; null means before the first step. */
	checkpoints: Array<{ goal: string; afterStep: string | null }>;
	/** State a Journey needs before its first step; empty when it needs none. */
	preconditions: string[];
	whyItMatters: string | null;
	/** A Journey, or a setup/teardown hook around the run (case-role-contract.mjs). */
	role: SuiteCaseRole;
	/** The Suite Case a per-journey hook is appended to, or null. */
	scopeCaseId: string | null;
	/** The index of a Journey proposed in the same list, when the scope is new too. */
	scopeCandidateIndex: number | null;
	ownerConfirmation: OwnerConfirmation;
	repeat: SuiteCaseRepeat;
	enabled: boolean;
	archived: boolean;
	change: ActivityProposalChange;
}

export interface ActivityProposalCandidate {
	kind: "create_suite" | "change_suite";
	targetSuiteId: string | null;
	baseDefinitionRevision: number | null;
	proposedSuiteName: string | null;
	productThesis: string | null;
	candidateDefinition: ActivityProposalCandidateDefinition[];
}

export type ActivityResultStatus =
	| "completed"
	| "needs_attention"
	| "auth_required";

export type ActivityResultAuthState =
	| "authenticated"
	| "unauthenticated"
	| "unknown";

export interface ActivityAgentResult {
	status: ActivityResultStatus;
	authState: ActivityResultAuthState;
	summary: string;
	publicMarkdown: string;
	visitedUrls: string[];
	proposals: ActivityProposalCandidate[];
	auth: { reason: string } | null;
	attentionCode: ActivityAttentionCode | null;
	recoveryAction: string | null;
}
