import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
	isRecord,
	rejectUnknownKeys,
	requiredString,
} from "@shipbash/contracts/runtime/contract-values.mjs";
import { resolveUnchangedCases } from "@shipbash/contracts/runtime/unchanged-cases.mjs";
import {
	type ActivityRuntimeInput,
	validateActivityRuntimeInput,
} from "./input.ts";
import { redactSensitiveValues, redactString } from "./redaction.ts";
import { validateActivityProposals } from "./result-candidate.ts";
import {
	RESULT_FIELD_KEYS,
	validateActivityAttentionDetails,
	validateActivityAuthDescriptor,
	validateActivityResultAuthState,
	validateActivityResultStatus,
	validateActivityVisitedUrls,
} from "./result-fields.ts";
import { validateActivityProposalSemantics } from "./result-semantics.ts";
import type { ActivityAgentResult } from "./result-types.ts";

export type {
	ActivityAgentResult,
	ActivityProposalCandidate,
} from "./result-types.ts";

// Mirrors createActivityResultContract in
// packages/contracts/src/runtime/activity-result-contract.mjs with deliberate
// divergences the pipeline depends on: the host converts integer checkpoint
// anchors to `step-N` ids, redacts free-text fields through its own redactor,
// THROWS on a change_suite rename the container silently drops, and only runs
// the proposal-semantics clauses when the activity is supplied. Rules change in BOTH copies.
export function validateActivityAgentResult(
	value: unknown,
	activityValue?: ActivityRuntimeInput,
	sensitiveValues: readonly string[] = [],
): ActivityAgentResult {
	const redactedValue = redactSensitiveValues(value, sensitiveValues);
	if (!isRecord(redactedValue)) {
		throw new Error("Activity result must be an object.");
	}
	rejectUnknownKeys(redactedValue, RESULT_FIELD_KEYS, "result");
	const activity = activityValue
		? validateActivityRuntimeInput(activityValue)
		: null;

	const status = validateActivityResultStatus(redactedValue.status);
	const authState = validateActivityResultAuthState(redactedValue.authState);
	const visitedUrls = validateActivityVisitedUrls(redactedValue.visitedUrls);
	// An unchanged Case is the Suite's own, taken by id after redaction: the
	// delivered copy, redacted or written by the agent, is never read.
	const proposals = validateActivityProposals(
		activity
			? resolveUnchangedCases(redactedValue.proposals, activity.suites)
			: redactedValue.proposals,
	);
	const auth = validateActivityAuthDescriptor(
		redactedValue,
		status,
		authState,
		proposals,
	);
	// needs_attention may carry proposals: the work a stopped leg kept for the
	// owner to review (mirrors activity-result-contract.mjs in the container).
	const { attentionCode, recoveryAction } = validateActivityAttentionDetails(
		redactedValue,
		status,
	);

	if (activity) validateActivityProposalSemantics(activity, proposals);

	return {
		status,
		authState,
		summary: redactString(
			requiredString(redactedValue.summary, "result.summary", 2_000),
			[],
			2_000,
		),
		publicMarkdown: redactString(
			requiredString(
				redactedValue.publicMarkdown,
				"result.publicMarkdown",
				20_000,
			),
			[],
			20_000,
		),
		visitedUrls: [...new Set(visitedUrls)],
		proposals,
		auth,
		attentionCode,
		recoveryAction,
	};
}

/**
 * The agent result a leg retained. A clean exit without a valid one is the leg
 * failing, so the read or validation error is thrown; after a non-zero exit or
 * a cancel the missing or invalid file is expected and reads as null.
 */
export async function readActivityResultFile(
	outputDirectory: string,
	input: ActivityRuntimeInput,
	sensitiveValues: readonly string[],
	exit: { exitCode: number | null; aborted: boolean },
): Promise<ActivityAgentResult | null> {
	try {
		return validateActivityAgentResult(
			JSON.parse(
				await readFile(join(outputDirectory, "activity-result.json"), "utf8"),
			),
			input,
			sensitiveValues,
		);
	} catch (error) {
		if (exit.exitCode === 0 && !exit.aborted) throw error;
		return null;
	}
}
