import {
	CANDIDATE_CHANGE_KINDS,
	CANDIDATE_FIELD_KEYS,
	validateCandidatePreconditionStrings,
} from "@shipbash/contracts/runtime/activity-contracts.mjs";
import {
	identifier,
	isRecord,
	positiveInteger,
	rejectUnknownKeys,
	requiredString,
} from "@shipbash/contracts/runtime/contract-values.mjs";
import {
	assertCheckpointCount,
	validateCandidateRoleFields,
} from "@shipbash/contracts/runtime/case-role-contract.mjs";
import { redactString } from "./redaction.ts";
import type {
	ActivityProposalCandidate,
	ActivityProposalCandidateDefinition,
	ActivityProposalChange,
} from "./result-types.ts";

const PROPOSAL_FIELD_KEYS = new Set([
	"kind",
	"targetSuiteId",
	"baseDefinitionRevision",
	"proposedSuiteName",
	"productThesis",
	"candidateDefinition",
]);
const CHECKPOINT_FIELD_KEYS = new Set(["goal", "afterStep"]);

function isCandidateChange(value: string): value is ActivityProposalChange {
	if (!CANDIDATE_CHANGE_KINDS.includes(value)) return false;
	return (
		value === "add" ||
		value === "update" ||
		value === "archive" ||
		value === "unchanged"
	);
}

/** Tolerates absence so a Runner that predates preconditions still parses. */
function validateCandidatePreconditions(
	value: unknown,
	field: string,
): string[] {
	return validateCandidatePreconditionStrings(
		value,
		field,
		requiredString,
		redactString,
	);
}

function validateCandidateSteps(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 40) {
		throw new Error(`${field} must contain between 1 and 40 instructions.`);
	}
	return value.map((step, index) =>
		requiredString(step, `${field}[${index}]`, 2_000),
	);
}

function validateCandidateCheckpoints(
	value: unknown,
	field: string,
	stepCount: number,
	role: string,
): ActivityProposalCandidateDefinition["checkpoints"] {
	if (!Array.isArray(value)) {
		throw new Error(`${field} must be an array of {goal, afterStep} objects.`);
	}
	assertCheckpointCount(value.length, role, field);
	return value.map((checkpoint, index) => {
		const checkpointField = `${field}[${index}]`;
		if (!isRecord(checkpoint)) {
			throw new Error(`${checkpointField} must be a {goal, afterStep} object.`);
		}
		rejectUnknownKeys(checkpoint, CHECKPOINT_FIELD_KEYS, checkpointField);
		const afterStep = checkpoint.afterStep;
		if (
			afterStep !== null &&
			(!Number.isSafeInteger(afterStep) ||
				Number(afterStep) < 1 ||
				Number(afterStep) > stepCount)
		) {
			throw new Error(
				`${checkpointField}.afterStep must be null or a step number between 1 and ${stepCount}.`,
			);
		}
		return {
			goal: requiredString(checkpoint.goal, `${checkpointField}.goal`, 1_000),
			afterStep: afterStep === null ? null : `step-${Number(afterStep)}`,
		};
	});
}

function validateCandidate(
	value: unknown,
	field: string,
): ActivityProposalCandidateDefinition {
	if (!isRecord(value)) throw new Error(`${field} must be an object.`);
	rejectUnknownKeys(value, new Set(CANDIDATE_FIELD_KEYS), field);
	const change = requiredString(value.change, `${field}.change`, 20);
	if (!isCandidateChange(change)) {
		throw new Error(`${field}.change is invalid.`);
	}
	if (
		typeof value.enabled !== "boolean" ||
		typeof value.archived !== "boolean"
	) {
		throw new Error(`${field} flags are invalid.`);
	}
	const steps = validateCandidateSteps(value.steps, `${field}.steps`);
	// Mirrors the container: absent reads as a repeatable Journey, and the
	// role decides how few checkpoints this candidate may carry.
	const roleFields = validateCandidateRoleFields(value, field, identifier);
	const checkpoints = validateCandidateCheckpoints(
		value.checkpoints,
		`${field}.checkpoints`,
		steps.length,
		roleFields.role,
	);
	return {
		id: value.id === null ? null : identifier(value.id, `${field}.id`),
		title: requiredString(value.title, `${field}.title`, 500),
		steps,
		category: requiredString(value.category, `${field}.category`, 120),
		checkpoints,
		preconditions: validateCandidatePreconditions(
			value.preconditions,
			`${field}.preconditions`,
		),
		whyItMatters:
			value.whyItMatters === null || value.whyItMatters === undefined
				? null
				: redactString(
						requiredString(value.whyItMatters, `${field}.whyItMatters`, 300),
					),
		...roleFields,
		enabled: value.enabled,
		archived: value.archived,
		change,
	};
}

function validateProposal(
	value: unknown,
	index: number,
): ActivityProposalCandidate {
	const field = `proposals[${index}]`;
	if (!isRecord(value)) throw new Error(`${field} must be an object.`);
	rejectUnknownKeys(value, PROPOSAL_FIELD_KEYS, field);
	const kind = requiredString(value.kind, `${field}.kind`, 32);
	if (kind !== "create_suite" && kind !== "change_suite") {
		throw new Error(`${field}.kind is invalid.`);
	}
	if (
		!Array.isArray(value.candidateDefinition) ||
		value.candidateDefinition.length > 200
	) {
		throw new Error(`${field}.candidateDefinition is invalid.`);
	}
	return {
		kind,
		targetSuiteId:
			value.targetSuiteId === null
				? null
				: identifier(value.targetSuiteId, `${field}.targetSuiteId`),
		baseDefinitionRevision:
			value.baseDefinitionRevision === null
				? null
				: positiveInteger(
						value.baseDefinitionRevision,
						`${field}.baseDefinitionRevision`,
					),
		proposedSuiteName:
			value.proposedSuiteName === null
				? null
				: requiredString(
						value.proposedSuiteName,
						`${field}.proposedSuiteName`,
						160,
					),
		productThesis:
			value.productThesis === null || value.productThesis === undefined
				? null
				: redactString(
						requiredString(value.productThesis, `${field}.productThesis`, 600),
					),
		candidateDefinition: value.candidateDefinition.map(
			(candidate, candidateIndex) =>
				validateCandidate(
					candidate,
					`${field}.candidateDefinition[${candidateIndex}]`,
				),
		),
	};
}

export function validateActivityProposals(
	value: unknown,
): ActivityProposalCandidate[] {
	if (!Array.isArray(value) || value.length > 50) {
		throw new Error("Activity proposals is invalid.");
	}
	return value.map(validateProposal);
}
