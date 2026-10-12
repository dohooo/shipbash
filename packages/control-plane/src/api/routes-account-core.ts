import { hashTeamInvitationToken } from "../team-invitations.ts";
import {
	acceptInvitationContract,
	sessionContract,
	startSessionContract,
	updateProfileContract,
} from "@shipbash/contracts/api/account";
import {
	parseBody,
	parseQuery,
	sendContractJson,
	sendContractNoContent,
} from "./contracts/server.ts";
import { matchRoute } from "./match-route.ts";
import { ApiError, selectedTeamId } from "./http.ts";
import { firstHandled } from "./route-handler.ts";
import type { RouteContext } from "./route-support.ts";
import { projectView } from "./views.ts";

/**
 * The one place an account is brought into existence or up to date with its
 * identities. The console calls it from its sign-in callback, before the first
 * page, so the proxy that page passes through already sees what the account
 * became: its profile, its personal team, and the company team (and admission)
 * its Workspace domain gave it. Everything else only reads the account.
 */
async function handleStartSession(context: RouteContext): Promise<boolean> {
	const { response, actor, options } = context;
	if (!matchRoute(context, startSessionContract)) return false;
	await options.store.bootstrapCurrentUser(actor);
	sendContractNoContent(response, 204, startSessionContract);
	return true;
}

async function handleSession(context: RouteContext): Promise<boolean> {
	const { url, response, actor, options } = context;
	if (!matchRoute(context, sessionContract)) return false;
	parseQuery(sessionContract.query, url);
	const current = await options.store.readCurrentUser(actor);
	// A session no sign-in started: signing in again starts it.
	if (!current) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
	const teams = await options.store.listTeams(actor);
	const activeTeamId = selectedTeamId(url, teams, current.defaultTeamId);
	const [projects, repositories] = await Promise.all([
		options.store.listProjects(actor, activeTeamId),
		options.store.listProjectRepositories(actor, activeTeamId),
	]);
	const repositoriesByProject = new Map(
		repositories.map((entry) => [entry.projectId, entry]),
	);
	sendContractJson(response, 200, sessionContract, {
		profile: current.profile,
		teams,
		activeTeamId,
		projects: projects.map((project) =>
			projectView(project, repositoriesByProject.get(project.id) ?? null),
		),
		integrations: { slack: Boolean(options.slack), github: Boolean(options.github) },
	});
	return true;
}

async function handleInvitationAcceptance(
	context: RouteContext,
): Promise<boolean> {
	const { request, response, actor, options } = context;
	if (!matchRoute(context, acceptInvitationContract)) return false;
	const { token } = await parseBody(request, acceptInvitationContract.body);
	const teamId = await options.store.acceptInvitation(
		actor,
		hashTeamInvitationToken(token),
	);
	sendContractJson(response, 200, acceptInvitationContract, { teamId });
	return true;
}

async function handleProfile(context: RouteContext): Promise<boolean> {
	const { request, response, actor, options } = context;
	if (!matchRoute(context, updateProfileContract)) return false;
	const { displayName } = await parseBody(request, updateProfileContract.body);
	const profile = await options.store.updateProfileDisplayName(
		actor,
		displayName,
	);
	sendContractJson(response, 200, updateProfileContract, {
		profile,
	});
	return true;
}

export const handleAccountCore = firstHandled(
	handleStartSession,
	handleSession,
	handleInvitationAcceptance,
	handleProfile,
);
