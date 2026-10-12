/**
 * The evidence gate's doors. `/api/team-access/:team` is addressed by slug or
 * id rather than by a resolved id, because its whole audience is readers whose
 * session cannot resolve that Team; the answers are shaped in the store to
 * disclose no more than the ask needs. Deciding a request is an ordinary
 * team-scoped route and stays under `/api/teams/:teamId`.
 */
import {
	requestTeamAccessContract,
	resolveTeamAccessRequestContract,
	teamAccessGateContract,
} from "@shipbash/contracts/api/team-access";
import {
	parseBody,
	parseParams,
	sendContractJson,
	sendContractNoContent,
} from "./contracts/server.ts";
import { matchRoute } from "./match-route.ts";
import { firstHandled } from "./route-handler.ts";
import type { RouteContext } from "./route-support.ts";

async function handleAccessGate(context: RouteContext): Promise<boolean> {
	const { request, response, actor, options } = context;
	const hit = matchRoute(context, teamAccessGateContract, requestTeamAccessContract);
	if (!hit) return false;
	if (request.method === "GET") {
		const { team } = parseParams(teamAccessGateContract.params, hit.raw);
		sendContractJson(
			response,
			200,
			teamAccessGateContract,
			await options.store.readTeamAccessGate(actor, team),
		);
		return true;
	}
	const { team } = parseParams(requestTeamAccessContract.params, hit.raw);
	sendContractJson(response, 200, requestTeamAccessContract, {
		requestedAt: await options.store.requestTeamAccess(actor, team),
	});
	return true;
}

async function handleAccessRequestDecision(
	context: RouteContext,
): Promise<boolean> {
	const { request, response, actor, options } = context;
	const hit = matchRoute(context, resolveTeamAccessRequestContract);
	if (!hit) return false;
	const { teamId, requestId } = parseParams(resolveTeamAccessRequestContract.params, hit.raw);
	const { decision } = await parseBody(
		request,
		resolveTeamAccessRequestContract.body,
	);
	await options.store.resolveTeamAccessRequest(
		actor,
		teamId,
		requestId,
		decision,
	);
	sendContractNoContent(response, 204, resolveTeamAccessRequestContract);
	return true;
}

export const handleTeamAccess = firstHandled(handleAccessGate, handleAccessRequestDecision);
