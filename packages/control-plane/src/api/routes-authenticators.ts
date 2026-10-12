import {
	authAttentionContract,
	readGitHubAuthenticatorContract,
	readGitHubAuthenticatorCodeContract,
	removeGitHubAuthenticatorContract,
	saveGitHubAuthenticatorContract,
} from "@shipbash/contracts/api/authenticators";
import {
	parseBody,
	parseParams,
	sendContractJson,
	sendContractNoContent,
} from "./contracts/server.ts";
import { requireConfigured } from "./http.ts";
import { projectContext, requireTeamAdmin, type RouteContext } from "./route-support.ts";

export async function handleAuthenticators(
	context: RouteContext,
): Promise<boolean> {
	const { url, request, response, actor, options } = context;
	const attention = /^\/api\/projects\/([^/]+)\/auth-attention$/u.exec(
		url.pathname,
	);
	const match =
		/^\/api\/projects\/([^/]+)\/sign-ins\/([^/]+)\/authenticator(\/code)?$/u.exec(
			url.pathname,
		);
	if (!(attention ?? match)) return false;
	const gateway = requireConfigured(
		options.authenticators,
		"AUTHENTICATOR_UNAVAILABLE",
		"Authenticator management is unavailable.",
	);
	if (attention && request.method === "GET")
		return handleAttention(context, attention[1]);
	if (!match) return false;
	const { projectId, signInId } = parseParams(
		readGitHubAuthenticatorContract.params,
		{ projectId: match[1], signInId: match[2] },
	);
	const { teamId, teamRole } = await projectContext(
		options.store,
		actor,
		projectId,
	);
	const scope = { actor, teamId, projectId, signInId };
	if (request.method === "GET" && !match[3]) {
		sendContractJson(
			response,
			200,
			readGitHubAuthenticatorContract,
			await gateway.read(scope),
		);
		return true;
	}
	return handleAuthenticatorAdmin(context, scope, teamRole, match[3]);
}

async function handleAuthenticatorAdmin(
	context: RouteContext,
	scope: import("../store/authenticators.ts").AuthenticatorScope,
	teamRole: string,
	suffix: string | undefined,
) {
	const { request, response, options } = context;
	const gateway = options.authenticators;
	if (!gateway) return false;
	requireTeamAdmin(teamRole, "Only a Team Admin may manage an authenticator.");
  if (request.method === "GET" && suffix === "/code") {
    sendContractJson(response, 200, readGitHubAuthenticatorCodeContract, await gateway.code(scope));
    return true;
  }
	if (request.method === "PUT") {
		if (suffix) return false;
		const body = await parseBody(request, saveGitHubAuthenticatorContract.body);
		sendContractJson(
			response,
			200,
			saveGitHubAuthenticatorContract,
			await gateway.save(scope, body),
		);
		return true;
	}
	if (request.method === "DELETE") {
		if (suffix) return false;
		await gateway.remove(scope);
		sendContractNoContent(response, 204, removeGitHubAuthenticatorContract);
		return true;
	}
	return false;
}

async function handleAttention(
	context: RouteContext,
	rawProjectId: string | undefined,
): Promise<boolean> {
	const { actor, options, url, response } = context;
	const authenticators = requireConfigured(
		options.authenticators,
		"AUTHENTICATOR_UNAVAILABLE",
		"Authenticator management is unavailable.",
	);
	const { projectId } = parseParams(authAttentionContract.params, {
		projectId: rawProjectId,
	});
	const { teamId } = await projectContext(options.store, actor, projectId);
	const query = authAttentionContract.query.parse({
		runId: url.searchParams.get("runId") ?? undefined,
	});
	const items = await authenticators.attention.list(
		actor,
		teamId,
		projectId,
		query.runId,
	);
	sendContractJson(response, 200, authAttentionContract, { items });
	return true;
}
