import {
	isRecord,
	optionalString,
	rejectUnknownKeys,
	requiredString,
} from "@shipbash/contracts/runtime/contract-values.mjs";
import { PUBLIC_ACTIVITY_RESULTS_ATTENTION_CODE_VALUES } from "@shipbash/contracts/runtime/generated/db-vocabularies.mjs";
import { redactString } from "./redaction.ts";
import type { ActivityAttentionCode } from "@shipbash/contracts/database-contract-types";
import type {
	ActivityAgentResult,
	ActivityProposalCandidate,
	ActivityResultAuthState,
	ActivityResultStatus,
} from "./result-types.ts";

export const RESULT_FIELD_KEYS = new Set([
	"status",
	"authState",
	"summary",
	"publicMarkdown",
	"visitedUrls",
	"proposals",
	"auth",
	"attentionCode",
	"recoveryAction",
]);

export function validateActivityResultStatus(
	value: unknown,
): ActivityResultStatus {
	const status = requiredString(value, "result.status", 32);
	if (
		status !== "completed" &&
		status !== "needs_attention" &&
		status !== "auth_required"
	) {
		throw new Error("Activity result status is invalid.");
	}
	return status;
}

export function validateActivityResultAuthState(
	value: unknown,
): ActivityResultAuthState {
	const authState = requiredString(value, "result.authState", 32);
	if (
		authState !== "authenticated" &&
		authState !== "unauthenticated" &&
		authState !== "unknown"
	) {
		throw new Error("Activity result authState is invalid.");
	}
	return authState;
}

export function validateActivityVisitedUrls(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 30) {
		throw new Error("Activity visitedUrls is invalid.");
	}
	return value.map((entry, index) => {
		let url: URL;
		try {
			url = new URL(requiredString(entry, `visitedUrls[${index}]`, 2_048));
		} catch {
			throw new Error(`visitedUrls[${index}] is invalid.`);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error(`visitedUrls[${index}] is invalid.`);
		}
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.toString();
	});
}

export function validateActivityAuthDescriptor(
	value: Record<string, unknown>,
	status: ActivityResultStatus,
	authState: ActivityResultAuthState,
	proposals: readonly ActivityProposalCandidate[],
): ActivityAgentResult["auth"] {
	if (status !== "auth_required") {
		if (value.auth !== null) {
			throw new Error("Only auth_required can include an auth descriptor.");
		}
		return null;
	}
	if (authState !== "unauthenticated") {
		throw new Error("auth_required must report authState unauthenticated.");
	}
	if (!isRecord(value.auth)) {
		throw new Error("auth_required needs a descriptor.");
	}
	rejectUnknownKeys(value.auth, new Set(["reason"]), "auth");
	const auth = {
		reason: redactString(requiredString(value.auth.reason, "auth.reason", 500)),
	};
	if (proposals.length) {
		throw new Error("auth_required cannot include proposals.");
	}
	return auth;
}

/**
 * The column's own vocabulary decides what a reason may be called, so a reason
 * added to the schema does not have to be spelled out here a second time.
 */
function isAttentionCode(value: string): value is ActivityAttentionCode {
	return PUBLIC_ACTIVITY_RESULTS_ATTENTION_CODE_VALUES.some(
		(allowed) => allowed === value,
	);
}

export function validateActivityAttentionDetails(
	value: Record<string, unknown>,
	status: ActivityResultStatus,
): Pick<ActivityAgentResult, "attentionCode" | "recoveryAction"> {
	const attentionCode =
		value.attentionCode === undefined || value.attentionCode === null
			? null
			: requiredString(value.attentionCode, "result.attentionCode", 64);
	if (attentionCode !== null && !isAttentionCode(attentionCode)) {
		throw new Error("result.attentionCode is invalid.");
	}
	const recoveryAction = optionalString(
		value.recoveryAction,
		"result.recoveryAction",
		500,
	);
	// Naming a reason is a claim that something can be done about it: every code
	// means the Activity needs attention and says what would clear it.
	if (attentionCode !== null && (status !== "needs_attention" || !recoveryAction)) {
		throw new Error(
			`${attentionCode} must include a needs_attention recoveryAction.`,
		);
	}
	if (
		status === "completed" &&
		(attentionCode !== null || recoveryAction !== null)
	) {
		throw new Error("A completed Activity may not include attention details.");
	}
	return {
		attentionCode,
		recoveryAction:
			recoveryAction === null ? null : redactString(recoveryAction, [], 500),
	};
}
