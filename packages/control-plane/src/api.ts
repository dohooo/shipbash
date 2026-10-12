import { isDeclaredPublicApiRoute } from "@shipbash/contracts/api/registry";

import { safeStoreError } from "./api/error-mapping.ts";
import {
	ApiError,
	actorForRequest,
	headerValue,
	sendJson,
	type ApiRequest,
	type ApiResponse,
} from "./api/http.ts";
import type { ApiOptions } from "./api/options.ts";
import { firstHandled } from "./api/route-handler.ts";
import type { RouteContext } from "./api/route-support.ts";
import { handleAccount } from "./api/routes-account.ts";
import { handleActivities } from "./api/routes-activities.ts";
import { handleAuth } from "./api/routes-auth.ts";
import { handleAuthenticators } from "./api/routes-authenticators.ts";
import {
	handleCli,
	handleCliLoginRequest,
	isCliLoginPath,
} from "./api/routes-cli.ts";
import { handleEvidence } from "./api/routes-evidence.ts";
import { handleJourneys } from "./api/routes-journeys.ts";
import { handleProjects } from "./api/routes-projects.ts";
import { handleProposals } from "./api/routes-proposals.ts";
import { handleRunShares } from "./api/routes-run-shares.ts";
import { handleRuns } from "./api/routes-runs.ts";
import { handleSignInTakeover } from "./api/routes-sign-in-takeover.ts";
import { handleSignInVerification } from "./api/routes-sign-in-verification.ts";
import { handleSignIns } from "./api/routes-sign-ins.ts";
import { handleTeamAccess } from "./api/routes-team-access.ts";
import {
	handleWaitlist,
	handleWaitlistInternalRequest,
	isWaitlistInternalPath,
} from "./api/routes-waitlist.ts";
import { HttpError } from "./service/http-input.ts";
import { ActivityNotRetryableError } from "./store/activity-retry.ts";
import { DraftKeepRequestError, ProposalConflictError } from "./store/proposal-conflict.ts";
import { RevisionConflictError } from "./store/revision-conflict.ts";
import { RunQuotaExceededError } from "./store/run-quota.ts";
import type { TenantActor } from "./types.ts";

export * from "./api/gateways.ts";
export { ApiError } from "./api/http.ts";
export type { ApiRequest, ApiResponse } from "./api/http.ts";
export type { ApiOptions } from "./api/options.ts";
export type { RouteContext } from "./api/route-support.ts";

const MAX_URL_LENGTH = 4_096;

export function isAuthenticatedApiPath(pathname: string): boolean {
	return /^\/api\/(?:session|invitations|profile|teams|team-access|github|slack|projects|case-runs|activities|cli|waitlist)(?:\/|$)/u.test(
		pathname,
	);
}

const handleDeclaredRoute = firstHandled(
	handleAuthenticators,
	handleAccount,
	handleTeamAccess,
	handleWaitlist,
	handleProjects,
	handleJourneys,
	handleActivities,
	handleAuth,
	handleRuns,
	handleEvidence,
	handleRunShares,
	handleProposals,
	handleCli,
	handleSignInTakeover,
	handleSignInVerification,
	handleSignIns,
);

/**
 * Who is calling: the console's signed actor envelope, or — for the public
 * CLI — a bearer token the CLI store resolves to its user. A token also
 * names itself to the routes that read or revoke the session it carries.
 */
async function callerOf(
	request: ApiRequest,
	options: ApiOptions,
): Promise<{ actor: TenantActor; cliToken: { id: string } | null }> {
	const authorization = headerValue(request, "authorization");
	if (authorization?.startsWith("Bearer ")) {
		const identity = options.cli
			? await options.cli.resolveToken(
					authorization.slice("Bearer ".length).trim(),
				)
			: null;
		if (!identity)
			throw new ApiError(
				401,
				"AUTHENTICATION_REQUIRED",
				"Authentication is required.",
			);
		return {
			actor: { userId: identity.userId },
			cliToken: { id: identity.tokenId },
		};
	}
	return {
		actor: actorForRequest(request, options.actorSigningSecret),
		cliToken: null,
	};
}

async function dispatchDeclaredRoute(context: RouteContext): Promise<void> {
	if (await handleDeclaredRoute(context)) return;
	throw new ApiError(404, "NOT_FOUND", "Route not found.");
}

/**
 * A write the store refused for the state it found: against a Suite revision
 * that has moved on (the caller reads the Suite again), or against a proposal
 * or walk in a state that does not take it (the code names the next step);
 * or a keep whose request names nothing it can keep (400); or a run the
 * team's monthly Run allowance refuses (429, with what was used of it).
 */
function storeConflict(error: unknown): HttpError | null {
	if (error instanceof RevisionConflictError) {
		return new HttpError(409, "REVISION_CONFLICT", error.message, { currentRevision: error.currentRevision });
	}
	if (error instanceof DraftKeepRequestError) return new HttpError(400, error.code, error.message);
	if (error instanceof ActivityNotRetryableError) return new HttpError(409, error.code, error.message);
	if (error instanceof RunQuotaExceededError) {
		return new HttpError(429, error.code, error.message, { used: error.used, quota: error.quota });
	}
	return error instanceof ProposalConflictError ? new HttpError(409, error.code, error.message) : null;
}

function respondWithApiError(response: ApiResponse, thrown: unknown): void {
	const error = storeConflict(thrown) ?? thrown;
	if (error instanceof ApiError || error instanceof HttpError) {
		sendJson(response, error.statusCode, {
			...(error instanceof HttpError ? error.details : {}),
			ok: false,
			error: error.code,
			message: error.message,
		});
		return;
	}
	const safe = safeStoreError(error);
	if (safe) {
		sendJson(response, safe.statusCode, {
			ok: false,
			error: safe.code,
			message: safe.message,
		});
		return;
	}
	// Surface the real failure in server logs — a silent 500 is undebuggable.
	console.error("[api] unhandled error:", error);
	sendJson(response, 500, {
		ok: false,
		error: "INTERNAL_ERROR",
		message: "The request could not be completed.",
	});
}

export async function handleApiRequest(
	request: ApiRequest,
	response: ApiResponse,
	options: ApiOptions,
): Promise<boolean> {
	const rawUrl = request.url ?? "/";
	if (rawUrl.length > MAX_URL_LENGTH)
		throw new ApiError(414, "URL_TOO_LONG", "Request URL is too long.");
	const url = new URL(rawUrl, "http://127.0.0.1");
	if (!isAuthenticatedApiPath(url.pathname)) return false;

	try {
		if (!isDeclaredPublicApiRoute(request.method ?? "GET", url.pathname)) {
			throw new ApiError(404, "NOT_FOUND", "Route not found.");
		}
		// `shipbash login` files and polls its pairing request before it is anyone.
		if (options.cli && isCliLoginPath(request.method ?? "GET", url.pathname)) {
			await handleCliLoginRequest(request, response, options.cli);
			return true;
		}
		// The internal waiting list is a shared password, not an account, so it is
		// answered before the caller is identified rather than after.
		if (isWaitlistInternalPath(request.method ?? "GET", url.pathname)) {
			await handleWaitlistInternalRequest(url, request, response, options);
			return true;
		}
		const { actor, cliToken } = await callerOf(request, options);
		const context = { url, request, response, actor, cliToken, options };
		await dispatchDeclaredRoute(context);
		return true;
	} catch (error) {
		respondWithApiError(response, error);
		return true;
	}
}
