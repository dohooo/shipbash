/**
 * Settings › GitHub: the team's connections, the repository each project
 * reads, and the redirects that connect an account. Every GitHub failure a
 * person can act on is named; a GitHub that does not answer reads as a 502.
 */
import {
	bindGitHubRepositoryContract,
	disconnectGitHubContract,
	githubInstallContract,
	githubRepositoriesContract,
	readGitHubRepositoryContract,
	teamGitHubConnectionsContract,
	unbindGitHubRepositoryContract,
} from "@shipbash/contracts/api/github";
import { isSameSitePath } from "@shipbash/contracts/same-site-path";

import { GitHubSecurityError } from "../github-app/errors.ts";
import { GitHubReadError } from "../github-app/reads.ts";
import { GITHUB_AUTHORIZATION_CALLBACK_PATH } from "../github-app/authorization.ts";
import type { GitHubSetupRedirect } from "../github-tenant-service-connect.ts";
import { GitHubAppUnavailableError } from "../github-tenant-service.ts";
import { INSTALL_STATE_PATTERN } from "../install-state.ts";
import { parseBody, parseParams, sendContractJson } from "./contracts/server.ts";
import type { GitHubGateway } from "./gateways.ts";
import { ApiError, requireConfigured, sendNoContent, sendSeeOther } from "./http.ts";
import { matchRoute } from "./match-route.ts";
import { firstHandled } from "./route-handler.ts";
import type { RouteContext } from "./route-support.ts";

const MAX_RETURN_PATH_LENGTH = 1_024;

function requireGitHub(context: RouteContext): GitHubGateway {
	return requireConfigured(context.options.github, "GITHUB_UNAVAILABLE", "GitHub is not configured on this deployment.");
}

/** The GitHub failures a person can do something about, as the answer that tells them what. */
function githubApiError(error: unknown): ApiError | null {
	if (error instanceof GitHubAppUnavailableError) {
		return new ApiError(503, "GITHUB_UNAVAILABLE", "GitHub is not configured on this deployment.");
	}
	if (error instanceof GitHubReadError && error.reason === "repository_unavailable") {
		return new ApiError(409, "GITHUB_REPOSITORY_UNAVAILABLE", error.message);
	}
	if (error instanceof GitHubReadError || error instanceof GitHubSecurityError) {
		return new ApiError(502, "GITHUB_UNREADABLE", "GitHub could not be read. Try again.");
	}
	return null;
}

/** A route body, with GitHub's failures answered as themselves and every other one left to the API. */
async function throughGitHub<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		throw githubApiError(error) ?? error;
	}
}

async function handleConnections(context: RouteContext): Promise<boolean> {
	const { response, actor, options } = context;
	const hit = matchRoute(context, teamGitHubConnectionsContract);
	if (!hit) return false;
	const { teamId } = parseParams(teamGitHubConnectionsContract.params, hit.raw);
	const connections = options.github ? await options.github.connections(actor, teamId) : [];
	sendContractJson(response, 200, teamGitHubConnectionsContract, { connections });
	return true;
}

/**
 * Where Connect goes. The pane's console route asks for it, then sends the
 * browser on; the address to come back to is written into the state and
 * never read back off GitHub's redirect.
 */
async function handleInstall(context: RouteContext): Promise<boolean> {
	const { request, response, actor } = context;
	const hit = matchRoute(context, githubInstallContract);
	if (!hit) return false;
	const { teamId } = parseParams(githubInstallContract.params, hit.raw);
	const { returnPath } = await parseBody(request, githubInstallContract.body);
	if (returnPath.length > MAX_RETURN_PATH_LENGTH || !isSameSitePath(returnPath)) {
		throw new ApiError(400, "INVALID_GITHUB_INSTALL", "The GitHub install request is invalid.");
	}
	const github = requireGitHub(context);
	const redirect = await throughGitHub(() => github.installRedirect(actor, teamId, returnPath));
	sendContractJson(response, 200, githubInstallContract, redirect);
	return true;
}

async function handleRepositories(context: RouteContext): Promise<boolean> {
	const { response, actor } = context;
	const hit = matchRoute(context, githubRepositoriesContract);
	if (!hit) return false;
	const { teamId, connectionId } = parseParams(githubRepositoriesContract.params, hit.raw);
	const github = requireGitHub(context);
	const listed = await throughGitHub(() => github.repositories(actor, teamId, connectionId));
	sendContractJson(response, 200, githubRepositoriesContract, listed);
	return true;
}

async function handleBind(context: RouteContext): Promise<boolean> {
	const { request, response, actor } = context;
	const hit = matchRoute(context, bindGitHubRepositoryContract);
	if (!hit) return false;
	const { teamId, projectId } = parseParams(bindGitHubRepositoryContract.params, hit.raw);
	const body = await parseBody(request, bindGitHubRepositoryContract.body);
	const github = requireGitHub(context);
	const binding = await throughGitHub(() => github.bind(actor, teamId, projectId, body));
	sendContractJson(response, 200, bindGitHubRepositoryContract, { binding });
	return true;
}

async function handleRead(context: RouteContext): Promise<boolean> {
	const { response, actor } = context;
	const hit = matchRoute(context, readGitHubRepositoryContract);
	if (!hit) return false;
	const { teamId, projectId } = parseParams(readGitHubRepositoryContract.params, hit.raw);
	const github = requireGitHub(context);
	const binding = await throughGitHub(() => github.read(actor, teamId, projectId));
	sendContractJson(response, 200, readGitHubRepositoryContract, { binding });
	return true;
}

async function handleUnbind(context: RouteContext): Promise<boolean> {
	const { actor } = context;
	const hit = matchRoute(context, unbindGitHubRepositoryContract);
	if (!hit) return false;
	const { teamId, projectId } = parseParams(unbindGitHubRepositoryContract.params, hit.raw);
	await requireGitHub(context).unbind(actor, teamId, projectId);
	sendNoContent(context.response);
	return true;
}

async function handleDisconnect(context: RouteContext): Promise<boolean> {
	const { actor } = context;
	const hit = matchRoute(context, disconnectGitHubContract);
	if (!hit) return false;
	const { teamId, connectionId } = parseParams(disconnectGitHubContract.params, hit.raw);
	await requireGitHub(context).disconnect(actor, teamId, connectionId);
	sendNoContent(context.response);
	return true;
}

/** Whatever a GitHub redirect ends as, the person is sent back to the pane, with what happened. */
function returnToPane(context: RouteContext, path: string, outcome: string): void {
	const location = new URL(path, context.options.publicBaseUrl);
	location.searchParams.set("github", outcome);
	sendSeeOther(context.response, location.toString());
}

async function handleManifestCallback(context: RouteContext): Promise<boolean> {
	const { url, request, actor, options } = context;
	if (request.method !== "GET" || url.pathname !== "/api/github/app-manifest/callback") return false;
	const completed = await requireGitHub(context).completeManifest(actor, {
		state: url.searchParams.get("state")?.trim() ?? "",
		code: url.searchParams.get("code")?.trim() ?? "",
	});
	const team = (await options.store.listTeams(actor)).find((entry) => entry.id === completed.teamId);
	if (!team) throw new ApiError(404, "TEAM_NOT_FOUND", "Team was not found.");
	returnToPane(context, `/${encodeURIComponent(team.slug)}/settings/github`, "app_registered");
	return true;
}

/**
 * GitHub only knows one callback URL. An authorization for a connect a
 * preview deployment started lands here on production; the state names the
 * preview, and the browser goes back there with the same callback to finish.
 */
async function previewHandoff(context: RouteContext, github: GitHubGateway, state: string): Promise<boolean> {
	if (!INSTALL_STATE_PATTERN.test(state)) return false;
	const returnOrigin = await github.installationReturnOrigin(context.actor, state);
	if (!returnOrigin || new URL(returnOrigin).origin === context.options.publicBaseUrl) return false;
	sendSeeOther(context.response, `${new URL(returnOrigin).origin}${context.url.pathname}${context.url.search}`);
	return true;
}

/**
 * GitHub's setup URL, reached three ways: after an install or a change to
 * one made from the pane (state and installation), after an organization
 * member asked its owners to approve (`setup_action=request`, no
 * installation, perhaps no state), and with an installation and no state of
 * this person's — they changed it on GitHub itself, or approved someone's
 * request as an owner. The first two go on to GitHub's authorization of the
 * App; the third changes nothing here and finds its way back.
 */
async function handleInstallationCallback(context: RouteContext): Promise<boolean> {
	const { url, request, actor } = context;
	if (request.method !== "GET" || url.pathname !== "/api/github/installations/callback") return false;
	const github = requireGitHub(context);
	const setup = setupRedirectOf(url);
	const authorize = setup.kind === "change" ? null : await throughGitHub(() => github.beginAuthorization(actor, setup));
	if (authorize) {
		sendSeeOther(context.response, authorize);
		return true;
	}
	if (setup.kind === "request") {
		throw new ApiError(400, "INVALID_GITHUB_CALLBACK", "The GitHub installation request has no state here.");
	}
	// No state of this person's names the installation: they changed it on
	// GitHub, or approved someone's request as an owner. Nothing connects here,
	// and nothing failed either.
	const home = await github.installationHome(actor, setup.installationId);
	returnToPane(context, home ?? await actorPane(context), home ? "updated" : "approved");
	return true;
}

/**
 * GitHub's setup redirect, read once: a request (perhaps without its state),
 * an install or a change to one from the pane (an installation and a state),
 * or a change made on GitHub itself (an installation and no state).
 */
function setupRedirectOf(url: URL): GitHubSetupRedirect | { kind: "change"; installationId: number } {
	const state = url.searchParams.get("state")?.trim() || null;
	if (url.searchParams.get("setup_action") === "request") return { kind: "request", state };
	const installationId = Number(url.searchParams.get("installation_id"));
	if (!Number.isSafeInteger(installationId) || installationId < 1) {
		throw new ApiError(400, "INVALID_GITHUB_CALLBACK", "The GitHub installation callback is invalid.");
	}
	return state ? { kind: "install", state, installationId } : { kind: "change", installationId };
}

/**
 * GitHub's authorization of the App, coming back with a code: what proves
 * the installation or request the setup redirect recorded belongs to this
 * person. A person who declined comes back with `error` and no code: their
 * state is spent, as Slack's is, so the pane stops reporting a connect in
 * flight.
 */
async function handleAuthorizationCallback(context: RouteContext): Promise<boolean> {
	const { url, request, actor } = context;
	if (request.method !== "GET" || url.pathname !== GITHUB_AUTHORIZATION_CALLBACK_PATH) return false;
	const github = requireGitHub(context);
	const state = url.searchParams.get("state")?.trim() ?? "";
	if (await previewHandoff(context, github, state)) return true;
	const code = url.searchParams.get("code")?.trim() ?? "";
	if (!code) {
		const returnPath = await github.declineAuthorization(actor, state);
		if (!returnPath) throw new ApiError(400, "INVALID_GITHUB_CALLBACK", "The GitHub authorization callback has expired.");
		returnToPane(context, returnPath, "denied");
		return true;
	}
	const { returnPath, outcome } = await throughGitHub(() => github.completeAuthorization(actor, { state, code }));
	returnToPane(context, returnPath, outcome);
	return true;
}

/** The GitHub pane of the person's own team, for a redirect that names none. */
async function actorPane(context: RouteContext): Promise<string> {
	const { actor, options } = context;
	const [current, teams] = await Promise.all([options.store.readCurrentUser(actor), options.store.listTeams(actor)]);
	const team = teams.find((entry) => entry.id === current?.defaultTeamId) ?? teams[0];
	return team ? `/${encodeURIComponent(team.slug)}/settings/github` : "/";
}

export const handleAccountGitHub = firstHandled(
	handleConnections,
	handleInstall,
	handleRepositories,
	handleBind,
	handleRead,
	handleUnbind,
	handleDisconnect,
	handleManifestCallback,
	handleInstallationCallback,
	handleAuthorizationCallback,
);
