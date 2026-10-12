import { completeAuthContract } from "@shipbash/contracts/api/auth";
import {
	cancelVerificationContract,
	rerunVerificationContract,
} from "@shipbash/contracts/api/runs";
import { callApi } from "./api-client";

interface VerificationAuthParams {
	projectId: string;
	targetCollection: "verifications";
	targetId: string;
}

function verificationAuthParams(
	projectId: string,
	runId: string,
): VerificationAuthParams {
	return {
		projectId,
		targetCollection: "verifications",
		targetId: runId,
	};
}

/**
 * Walks the run's suite again as a new run. The key names the reader's one
 * intent: the same key sent again is answered with the run it already queued.
 */
export function rerunVerification(projectId: string, runId: string, clientIdempotencyKey: string) {
	return callApi(rerunVerificationContract, {
		params: { projectId, runId },
		body: { clientIdempotencyKey },
	});
}

export function cancelVerification(projectId: string, runId: string) {
	return callApi(cancelVerificationContract, { params: { projectId, runId } });
}

/** The reader is done at the sign-in wall: the run takes the session and resumes. */
export function completeVerificationAuth(projectId: string, runId: string) {
	return callApi(completeAuthContract, {
		params: verificationAuthParams(projectId, runId),
	});
}
