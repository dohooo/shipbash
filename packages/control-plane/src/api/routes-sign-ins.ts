/**
 * The Team's pool of saved sign-ins.
 *
 * Who may do what follows the thing itself: a sign-in is how the whole Team
 * gets into its own live product, so any member may see that it exists and
 * what state it is in, and only an Admin may add or take one away. Both
 * changes leave an event row, because "who removed this way in" is a
 * question the Team page has to be able to answer.
 *
 * Removal is a revocation, not a delete: the row stays, its sealed material is
 * destroyed, and the list stops carrying it. A hard delete would take the
 * audit trail with it — the event rows cascade off the sign-in.
 */
import {
	createTeamSignInContract,
	deleteTeamSignInContract,
	teamSignInsContract,
} from "@shipbash/contracts/api/sign-ins";

import type { ApiOptions } from "../api.ts";
import { reapStrandedSignIns } from "../service/sign-in-reaper.ts";
import { SignInCryptoError } from "../sign-in-crypto.ts";
import type { TenantActor } from "../types.ts";
import { parseBody, parseParams, sendContractJson, sendContractNoContent } from "./contracts/server.ts";
import { matchRoute } from "./match-route.ts";
import { ApiError } from "./http.ts";
import { handleProjectSignIns } from "./routes-project-sign-ins.ts";
import { firstHandled } from "./route-handler.ts";
import type { RouteContext } from "./route-support.ts";
import { teamSignInView } from "./sign-in-views.ts";

/**
 * Membership as a route-level answer. The read itself runs under row-level
 * security and would simply return nothing for a stranger, which reads as "the
 * Team saved none" — a different statement from "this is not your Team".
 */
async function requireTeamMembership(
	store: ApiOptions["store"],
	actor: TenantActor,
	teamId: string,
): Promise<void> {
	const teams = await store.listTeams(actor);
	if (!teams.some((team) => team.id === teamId)) {
		throw new ApiError(403, "FORBIDDEN", "You do not have permission to perform this action.");
	}
}

/**
 * A deployment with no sealing key cannot store a credential at all. That is
 * an operator's missing configuration, not a bad request, so it is answered as
 * unavailable and the key's name never travels to a client.
 */
function sealingUnavailable(error: unknown): never {
	if (error instanceof SignInCryptoError) {
		throw new ApiError(
			503,
			"SIGN_IN_SEALING_UNAVAILABLE",
			"Saving a sign-in needs this deployment's sign-in encryption key.",
		);
	}
	throw error;
}

async function handleList(context: RouteContext): Promise<boolean> {
	const { response, actor, options } = context;
	const hit = matchRoute(context, teamSignInsContract);
	if (!hit) return false;
	const { teamId } = parseParams(teamSignInsContract.params, hit.raw);
	await requireTeamMembership(options.store, actor, teamId);
	// The Team page shows the same rows, so it settles the same abandoned ones.
	const signIns = await reapStrandedSignIns(options.store, {
		actor,
		teamId,
		signIns: await options.store.listTeamSignIns(actor, teamId),
		hasLiveStream: (id) => Boolean(options.signInVerification?.streamUrl(id)),
	});
	sendContractJson(response, 200, teamSignInsContract, {
		signIns: signIns.map(teamSignInView),
	});
	return true;
}

async function handleCreate(context: RouteContext): Promise<boolean> {
	const { request, response, actor, options } = context;
	const hit = matchRoute(context, createTeamSignInContract);
	if (!hit) return false;
	const { teamId } = parseParams(createTeamSignInContract.params, hit.raw);
	const body = await parseBody(request, createTeamSignInContract.body);
	const signIn = await options.store
		.createTeamSignIn(actor, teamId, {
			method: body.method,
			loginUrl: body.loginUrl ?? null,
			credential: body.credential
				? { ...body.credential, totpSecret: body.credential.totpSecret ?? null }
				: null,
		})
		.catch(sealingUnavailable);
	await options.store.recordTeamSignInEvent(actor, teamId, {
		signInId: signIn.id,
		actor: "user",
		action: "saved",
	});
	sendContractJson(response, 201, createTeamSignInContract, { signIn: teamSignInView(signIn) });
	return true;
}

async function handleRemove(context: RouteContext): Promise<boolean> {
	const { response, actor, options } = context;
	const hit = matchRoute(context, deleteTeamSignInContract);
	if (!hit) return false;
	const { teamId, signInId } = parseParams(deleteTeamSignInContract.params, hit.raw);
	const revoked = await options.store.revokeTeamSignIn(actor, teamId, signInId);
	if (!revoked) throw new ApiError(404, "SIGN_IN_NOT_FOUND", "This sign-in was not found.");
	// After the revocation, not before: revoking keeps the row, so the event
	// still has a sign-in to point at, and a row that was never there never
	// gets an event saying someone took it away.
	await options.store.recordTeamSignInEvent(actor, teamId, {
		signInId: revoked.id,
		actor: "user",
		action: "removed",
	});
	sendContractNoContent(response, 204, deleteTeamSignInContract);
	return true;
}

export const handleSignIns = firstHandled(
	handleList,
	handleCreate,
	handleRemove,
	handleProjectSignIns,
);
