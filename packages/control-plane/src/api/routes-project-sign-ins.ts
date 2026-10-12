/**
 * Which of the Team's sign-ins this Project uses, and which one its
 * verification runs sign in with.
 *
 * The Project never owns a credential — it owns a choice, so these verbs move
 * a binding and nothing else, bar the one that moves the runs: that one also
 * starts them from the session of the way in it chose. The projection they
 * answer with is the Team's own view of a sign-in, which is why a Project read
 * can be a member's while binding one, a decision about how a run reaches the
 * live product, stays an Admin's.
 */
import {
	bindProjectSignInContract,
	chooseProjectRunSignInContract,
	projectSignInsContract,
	unbindProjectSignInContract,
} from "@shipbash/contracts/api/sign-ins";

import { reapStrandedSignIns } from "../service/sign-in-reaper.ts";
import { parseBody, parseParams, sendContractJson, sendContractNoContent } from "./contracts/server.ts";
import { matchRoute } from "./match-route.ts";
import { ApiError, requireConfigured } from "./http.ts";
import { firstHandled } from "./route-handler.ts";
import { projectContext, requireTeamAdmin, type RouteContext } from "./route-support.ts";
import { boundSignInView, projectSignInBindingView } from "./sign-in-views.ts";

async function handleList(context: RouteContext): Promise<boolean> {
	const { response, actor, options } = context;
	const hit = matchRoute(context, projectSignInsContract);
	if (!hit) return false;
	const { projectId } = parseParams(projectSignInsContract.params, hit.raw);
	const { teamId } = await projectContext(options.store, actor, projectId);
	// A row whose leg never came back would read as "checking" on every card
	// that shows it, so the list settles what no leg can still be working on.
	const signIns = await reapStrandedSignIns(options.store, {
		actor,
		teamId,
		signIns: await options.store.listProjectSignIns(actor, teamId, projectId),
		hasLiveStream: (id) => Boolean(options.signInVerification?.streamUrl(id)),
	});
	sendContractJson(response, 200, projectSignInsContract, {
		signIns: signIns.map(boundSignInView),
	});
	return true;
}

async function handleBind(context: RouteContext): Promise<boolean> {
	const { request, response, actor, options } = context;
	const hit = matchRoute(context, bindProjectSignInContract);
	if (!hit) return false;
	const { projectId } = parseParams(bindProjectSignInContract.params, hit.raw);
	const { teamId, teamRole } = await projectContext(options.store, actor, projectId);
	requireTeamAdmin(teamRole, "Only a Team Admin may choose this Project's sign-ins.");
	const { signInId } = await parseBody(request, bindProjectSignInContract.body);
	const binding = await options.store.bindProjectSignIn(actor, teamId, projectId, signInId);
	// No event: the credential is what is saved, and the door that created it
	// already said so. Saving a way in from the console is this call and that
	// one, and a trail that records both reads as two saves 59ms apart.
	sendContractJson(response, 201, bindProjectSignInContract, {
		binding: projectSignInBindingView(binding),
	});
	return true;
}

async function handleUnbind(context: RouteContext): Promise<boolean> {
	const { response, actor, options } = context;
	const hit = matchRoute(context, unbindProjectSignInContract);
	if (!hit) return false;
	const { projectId, signInId } = parseParams(unbindProjectSignInContract.params, hit.raw);
	const { teamId, teamRole } = await projectContext(options.store, actor, projectId);
	requireTeamAdmin(teamRole, "Only a Team Admin may choose this Project's sign-ins.");
	const unbound = await options.store.unbindProjectSignIn(actor, teamId, projectId, signInId);
	if (!unbound) {
		throw new ApiError(404, "SIGN_IN_NOT_FOUND", "This Project does not use that sign-in.");
	}
	await options.store.recordTeamSignInEvent(actor, teamId, {
		signInId,
		projectId,
		actor: "user",
		action: "removed",
	});
	sendContractNoContent(response, 204, unbindProjectSignInContract);
	return true;
}

async function handleChooseForRuns(context: RouteContext): Promise<boolean> {
	const { response, actor, options } = context;
	const hit = matchRoute(context, chooseProjectRunSignInContract);
	if (!hit) return false;
	const { projectId, signInId } = parseParams(chooseProjectRunSignInContract.params, hit.raw);
	const gateway = requireConfigured(
		options.signInVerification,
		"SIGN_IN_VERIFICATION_UNAVAILABLE",
		"Choosing how runs sign in is not available here.",
	);
	const { teamId, teamRole } = await projectContext(options.store, actor, projectId);
	requireTeamAdmin(teamRole, "Only a Team Admin may choose how this Project's runs sign in.");
	await gateway.chooseForRuns({ actor, teamId, projectId, signInId });
	sendContractNoContent(response, 204, chooseProjectRunSignInContract);
	return true;
}

export const handleProjectSignIns = firstHandled(handleList, handleBind, handleUnbind, handleChooseForRuns);
