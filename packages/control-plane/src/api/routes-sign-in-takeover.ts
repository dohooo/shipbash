/**
 * Taking over the Project's sign-in browser, and handing it back.
 *
 * There is nothing else to plumb: the canvas connects straight to the stream
 * this grant names and claims input on that same socket with the control
 * token, exactly as an Activity takeover does. Input never travels over HTTP.
 */
import {
	releaseSignInTakeoverContract,
	startSignInTakeoverContract,
} from "@shipbash/contracts/api/sign-in-takeover";

import type { ApiOptions } from "../api.ts";
import { parseBody, parseParams, sendContractJson, sendContractNoContent } from "./contracts/server.ts";
import { requireConfigured } from "./http.ts";
import { matchRoute } from "./match-route.ts";
import { projectContext, requireTeamAdmin, type RouteContext } from "./route-support.ts";

function requireGateway(options: ApiOptions): NonNullable<ApiOptions["signInTakeover"]> {
	return requireConfigured(
		options.signInTakeover,
		"SIGN_IN_TAKEOVER_UNAVAILABLE",
		"Signing in to this product by hand is not available here.",
	);
}

/**
 * Both verbs decide who is driving a browser that can reach the owner's live
 * product, so both are a Team Admin's call.
 */
async function adminScope(context: RouteContext, rawProjectId: string | undefined): Promise<{
	teamId: string;
	projectId: string;
}> {
	const { projectId } = parseParams(startSignInTakeoverContract.params, { projectId: rawProjectId });
	const { teamId, teamRole } = await projectContext(context.options.store, context.actor, projectId);
	requireTeamAdmin(teamRole, "Only a Team Admin may sign in to this product by hand.");
	return { teamId, projectId };
}

export async function handleSignInTakeover(context: RouteContext): Promise<boolean> {
	const { request, response, actor, options } = context;
	const release = matchRoute(context, releaseSignInTakeoverContract);
	if (release) {
		const gateway = requireGateway(options);
		const { teamId, projectId } = await adminScope(context, release.raw.projectId);
		await gateway.release({ actor, teamId, projectId });
		sendContractNoContent(response, 204, releaseSignInTakeoverContract);
		return true;
	}

	const takeover = matchRoute(context, startSignInTakeoverContract);
	if (!takeover) return false;
	const gateway = requireGateway(options);
	const { teamId, projectId } = await adminScope(context, takeover.raw.projectId);
	const { method } = await parseBody(request, startSignInTakeoverContract.body);
	const grant = await gateway.takeover({ actor, teamId, projectId, method: method ?? null });
	sendContractJson(response, 200, startSignInTakeoverContract, grant);
	return true;
}
