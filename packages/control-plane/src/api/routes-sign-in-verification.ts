/**
 * Finishing a sign-in by hand, and reading the check that decides it.
 *
 * Both verbs are a Team Admin's: one saves a live session into the Team's
 * shared credentials, the other watches the browser that is proving it. The
 * completion answers 202 on purpose — the sign-in it returns is `verifying`,
 * and the tick arrives later from the leg, not from this request.
 */
import {
	completeSignInTakeoverContract,
	readSignInVerificationContract,
	verifySignInContract,
} from "@shipbash/contracts/api/sign-in-verification";

import type { ApiOptions } from "../api.ts";
import { reapStrandedSignIns } from "../service/sign-in-reaper.ts";
import { parseBody, parseParams, sendContractJson } from "./contracts/server.ts";
import { ApiError, requireConfigured } from "./http.ts";
import { matchRoute } from "./match-route.ts";
import { projectContext, requireTeamAdmin, type RouteContext } from "./route-support.ts";
import { teamSignInView } from "./sign-in-views.ts";

function requireGateway(options: ApiOptions): NonNullable<ApiOptions["signInVerification"]> {
	return requireConfigured(
		options.signInVerification,
		"SIGN_IN_VERIFICATION_UNAVAILABLE",
		"Checking a sign-in is not available here.",
	);
}

async function adminScope(context: RouteContext, projectId: string): Promise<string> {
	const { teamId, teamRole } = await projectContext(context.options.store, context.actor, projectId);
	requireTeamAdmin(teamRole, "Only a Team Admin may save or check a sign-in.");
	return teamId;
}

async function handleComplete(context: RouteContext, rawProjectId: string): Promise<void> {
	const { request, response, actor, options } = context;
	const gateway = requireGateway(options);
	const { projectId } = parseParams(completeSignInTakeoverContract.params, { projectId: rawProjectId });
	const teamId = await adminScope(context, projectId);
	const { method, signInId } = await parseBody(request, completeSignInTakeoverContract.body);
	const signIn = await gateway.complete({ actor, teamId, projectId, method, signInId: signInId ?? null });
	sendContractJson(response, 202, completeSignInTakeoverContract, { signIn: teamSignInView(signIn) });
}

/**
 * "Check this one again", for a sign-in the list already holds. There is no
 * browser to take back, so the request starts a leg — the auto-login one for a
 * saved password, the verification one for a session already kept — and
 * answers 202 with a sign-in that is `verifying`; the page follows it with the
 * reading route, as it does for a sign-in somebody finished by hand.
 */
async function handleVerify(
	context: RouteContext,
	rawProjectId: string,
	rawSignInId: string,
): Promise<void> {
	const { response, actor, options } = context;
	const gateway = requireGateway(options);
	const { projectId, signInId } = parseParams(verifySignInContract.params, {
		projectId: rawProjectId,
		signInId: rawSignInId,
	});
	const teamId = await adminScope(context, projectId);
	const signIn = await gateway.verify({ actor, teamId, projectId, signInId });
	sendContractJson(response, 202, verifySignInContract, { signIn: teamSignInView(signIn) });
}

async function handleVerification(
	context: RouteContext,
	rawProjectId: string,
	rawSignInId: string,
): Promise<void> {
	const { response, actor, options } = context;
	const gateway = requireGateway(options);
	const { projectId, signInId } = parseParams(readSignInVerificationContract.params, {
		projectId: rawProjectId,
		signInId: rawSignInId,
	});
	const teamId = await adminScope(context, projectId);
	// Read through the Project's own bindings, so a sign-in another Project
	// saved is a 404 here rather than a status this Project can watch.
	//
	// This is the route the page polls while a check runs, so it is also where
	// a check nobody is running any more has to be settled: otherwise the poll
	// never ends and the card spins for good.
	const signIns = await reapStrandedSignIns(options.store, {
		actor,
		teamId,
		signIns: await options.store.listProjectSignIns(actor, teamId, projectId),
		hasLiveStream: (id) => Boolean(gateway.streamUrl(id)),
	});
	const signIn = signIns.find((candidate) => candidate.id === signInId);
	if (!signIn) throw new ApiError(404, "NOT_FOUND", "This Project has no such sign-in.");
	sendContractJson(response, 200, readSignInVerificationContract, {
		status: signIn.status,
		// Only a leg that is running has a stream; a finished one has none.
		streamUrl: signIn.status === "verifying" ? gateway.streamUrl(signIn.id) : null,
		failureReason: signIn.failureReason,
		label: signIn.label,
	});
}

export async function handleSignInVerification(context: RouteContext): Promise<boolean> {
	const complete = matchRoute(context, completeSignInTakeoverContract);
	if (complete?.raw.projectId) {
		await handleComplete(context, complete.raw.projectId);
		return true;
	}
	const verify = matchRoute(context, verifySignInContract);
	if (verify?.raw.projectId && verify.raw.signInId) {
		await handleVerify(context, verify.raw.projectId, verify.raw.signInId);
		return true;
	}
	const verification = matchRoute(context, readSignInVerificationContract);
	if (!verification?.raw.projectId || !verification.raw.signInId) return false;
	await handleVerification(context, verification.raw.projectId, verification.raw.signInId);
	return true;
}
