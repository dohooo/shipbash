import {
	abandonSlackInstallContract,
	bindSlackChannelContract,
	confirmSlackConnectContract,
	disconnectSlackWorkspaceContract,
	getSlackConnectContract,
	slackChannelsContract,
	teamSlackConnectionsContract,
	testSlackBindingContract,
	unbindSlackChannelContract,
} from "@shipbash/contracts/api/slack";
import { INSTALL_STATE_PATTERN, InstallStateError } from "../install-state.ts";
import { SLACK_ID_PATTERN, SlackInstallError } from "../slack-app.ts";
import { SlackCallError } from "../slack-channels.ts";
import { SlackSignInError } from "../slack-sign-in.ts";
import { SlackNotDeliveringError } from "../slack-workspace-door.ts";
import { slackReturnPath } from "../store/slack-workspaces.ts";
import { parseBody, parseParams, sendContractJson, sendContractNoContent } from "./contracts/server.ts";
import { matchRoute } from "./match-route.ts";
import { ApiError, requireConfigured, sendNoContent, sendSeeOther } from "./http.ts";
import type { RouteContext } from "./route-support.ts";

/** Whatever a Slack redirect ends as, the person is sent back to the pane they left. */
function returnToPane(context: RouteContext, returnPath: string, outcome: string): void {
	const location = new URL(returnPath, context.options.publicBaseUrl);
	location.searchParams.set("slack", outcome);
	sendSeeOther(context.response, location.toString());
}

function requireSlack(context: RouteContext) {
	return requireConfigured(context.options.slack, "SLACK_UNAVAILABLE", "Slack is not configured on this deployment.");
}

async function handleConnections(context: RouteContext): Promise<boolean> {
	const { response, actor, options } = context;
	const hit = matchRoute(context, teamSlackConnectionsContract);
	if (!hit) return false;
	const { teamId } = parseParams(teamSlackConnectionsContract.params, hit.raw);
	sendContractJson(
		response,
		200,
		teamSlackConnectionsContract,
		await options.store.listSlackConnections(actor, teamId),
	);
	return true;
}

async function handleDisconnect(context: RouteContext): Promise<boolean> {
	const { actor } = context;
	const hit = matchRoute(context, disconnectSlackWorkspaceContract);
	if (!hit) return false;
	const { teamId, workspaceId } = parseParams(disconnectSlackWorkspaceContract.params, hit.raw);
	await requireSlack(context).disconnect(actor, teamId, workspaceId);
	sendNoContent(context.response);
	return true;
}

async function handleChannels(context: RouteContext): Promise<boolean> {
	const { response, actor } = context;
	const hit = matchRoute(context, slackChannelsContract);
	if (!hit) return false;
	const { teamId, workspaceId } = parseParams(slackChannelsContract.params, hit.raw);
	const listed = await requireSlack(context).channels(actor, teamId, workspaceId);
	sendContractJson(response, 200, slackChannelsContract, listed);
	return true;
}

/**
 * Adding a channel a project alerts into. Slack refusing the channel is an
 * answer and not a fault, so it comes back as a 200 naming the reason and
 * nothing saved — the pane draws that reason in the row it belongs to. Slack
 * refusing the token is neither, and by the time it reaches here the
 * workspace has already been marked revoked.
 */
async function handleBindChannel(context: RouteContext): Promise<boolean> {
	const { request, response, actor } = context;
	const hit = matchRoute(context, bindSlackChannelContract);
	if (!hit) return false;
	const { teamId, projectId, channelId } = parseParams(bindSlackChannelContract.params, hit.raw);
	const { workspaceId } = await parseBody(request, bindSlackChannelContract.body);
	const refused = await requireSlack(context).bindChannel(actor, teamId, projectId, { workspaceId, channelId });
	sendContractJson(response, 200, bindSlackChannelContract, { refused });
	return true;
}

/** The test message to one of a project's channels, answered the same way. */
async function handleTestBinding(context: RouteContext): Promise<boolean> {
	const { response, actor } = context;
	const hit = matchRoute(context, testSlackBindingContract);
	if (!hit) return false;
	const { teamId, ...route } = parseParams(testSlackBindingContract.params, hit.raw);
	const deliveryError = await requireSlack(context).testBinding(actor, teamId, route);
	sendContractJson(response, 200, testSlackBindingContract, { deliveryError });
	return true;
}

async function handleUnbindChannel(context: RouteContext): Promise<boolean> {
	const { actor, options } = context;
	const hit = matchRoute(context, unbindSlackChannelContract);
	if (!hit) return false;
	const { teamId, ...route } = parseParams(unbindSlackChannelContract.params, hit.raw);
	await options.store.unbindSlackChannel(actor, teamId, route);
	sendNoContent(context.response);
	return true;
}

async function handleAbandonInstall(context: RouteContext): Promise<boolean> {
	const { actor, options } = context;
	const hit = matchRoute(context, abandonSlackInstallContract);
	if (!hit) return false;
	const { teamId } = parseParams(abandonSlackInstallContract.params, hit.raw);
	await options.store.abandonSlackInstall(actor, teamId);
	sendNoContent(context.response);
	return true;
}

/**
 * The browser leaves for Slack here. It is a navigation from the pane rather
 * than a fetch, so the team and the address to come back to travel in the
 * query — and both are written into the state row the callback is trusted
 * through, never read back off the redirect.
 */
async function handleInstall(context: RouteContext): Promise<boolean> {
	const { url, request, actor } = context;
	if (request.method !== "GET" || url.pathname !== "/api/slack/install") return false;
	const teamId = url.searchParams.get("team")?.trim() ?? "";
	let returnPath: string;
	try {
		returnPath = slackReturnPath(url.searchParams.get("return") ?? "");
	} catch {
		throw new ApiError(400, "INVALID_SLACK_INSTALL", "The Slack install request is invalid.");
	}
	if (!teamId) {
		throw new ApiError(400, "INVALID_SLACK_INSTALL", "The Slack install request is invalid.");
	}
	const authorizeUrl = await requireSlack(context).authorizeUrl(actor, teamId, returnPath);
	sendSeeOther(context.response, authorizeUrl);
	return true;
}

/**
 * Slack sends the browser back here. A refusal in Slack and a refused exchange
 * both land on the pane with a reason rather than on an error page: the person
 * is mid-install, and the pane is where the retry lives. Anything else is a
 * fault of ours and is reported as one.
 */
async function handleOAuthCallback(context: RouteContext): Promise<boolean> {
	const { url, request, actor } = context;
	if (request.method !== "GET" || url.pathname !== "/api/slack/oauth/callback") return false;
	const slack = requireSlack(context);
	const state = url.searchParams.get("state")?.trim() ?? "";
	if (!INSTALL_STATE_PATTERN.test(state)) {
		throw new ApiError(400, "INVALID_SLACK_CALLBACK", "The Slack install callback is invalid.");
	}
	const returnPath = await slack.installReturn(actor, state);
	if (!returnPath) {
		throw new ApiError(400, "INVALID_SLACK_CALLBACK", "The Slack install callback has expired.");
	}
	const code = url.searchParams.get("code")?.trim() ?? "";
	if (!code) {
		// Slack answers a refusal with `error` and no code. The person has given
		// their answer, so the state is spent here: left unconsumed it would keep
		// the pane reporting an install that is still in flight.
		await slack.deny(actor, state);
		returnToPane(context, returnPath, "denied");
		return true;
	}
	try {
		await slack.complete(actor, { state, code, returnPath });
		returnToPane(context, returnPath, "connected");
	} catch (error) {
		if (!(error instanceof InstallStateError) && !(error instanceof SlackInstallError)) throw error;
		returnToPane(context, returnPath, "failed");
	}
	return true;
}

/**
 * Leaving for Sign in with Slack, from the page @ShipBash's sign-in card
 * opens. The workspace and channel are where @ShipBash asked from: hints for
 * the trip, never who signs in.
 */
async function handleSignIn(context: RouteContext): Promise<boolean> {
	const { url, request, actor } = context;
	if (request.method !== "GET" || url.pathname !== "/api/slack/sign-in") return false;
	const slackTeamId = url.searchParams.get("team")?.trim() ?? "";
	const channelId = url.searchParams.get("channel")?.trim() ?? "";
	if (!SLACK_ID_PATTERN.test(slackTeamId) || !SLACK_ID_PATTERN.test(channelId)) {
		throw new ApiError(400, "INVALID_SLACK_SIGN_IN", "The Slack sign-in request is invalid.");
	}
	const authorizeUrl = await requireSlack(context).signInUrl(actor, { slackTeamId, channelId });
	sendSeeOther(context.response, authorizeUrl);
	return true;
}

/**
 * Slack sends the browser back here, and every ending lands on the sign-in
 * page: the identity to confirm, or why there is none. A refusal in Slack
 * comes back with no code and ends the same way as one Slack made itself.
 */
async function handleSignInCallback(context: RouteContext): Promise<boolean> {
	const { url, request, actor } = context;
	if (request.method !== "GET" || url.pathname !== "/api/slack/sign-in/callback") return false;
	const slack = requireSlack(context);
	const page = new URL("/slack/connect", context.options.publicBaseUrl);
	const state = url.searchParams.get("state")?.trim() ?? "";
	const code = url.searchParams.get("code")?.trim() ?? "";
	if (!code) {
		page.searchParams.set("failed", "refused");
	} else {
		try {
			page.searchParams.set("signIn", await slack.completeSignIn(actor, { state, code }));
		} catch (error) {
			if (!(error instanceof SlackSignInError)) throw error;
			page.searchParams.set("failed", error.reason);
		}
	}
	sendSeeOther(context.response, page.toString());
	return true;
}

/** An attempt that expired, was confirmed already, or is not the caller's: the person signs in from Slack again. */
function expiredSignIn(): ApiError {
	return new ApiError(
		404,
		"SLACK_CONNECT_EXPIRED",
		"This sign-in has expired. Mention @ShipBash in Slack to sign in again.",
	);
}

/** What the confirm screen names before anything is written. */
async function handleConnectRead(context: RouteContext): Promise<boolean> {
	const hit = matchRoute(context, getSlackConnectContract);
	if (!hit) return false;
	const { signInId } = parseParams(getSlackConnectContract.params, hit.raw);
	const request = await context.options.store.readSlackSignIn(context.actor, signInId);
	if (!request) throw expiredSignIn();
	sendContractJson(context.response, 200, getSlackConnectContract, { request });
	return true;
}

/**
 * The caller confirmed: the Slack user their sign-in verified is them from
 * now on. Confirming is a person reading the screen that names that Slack
 * user, so a CLI token, which has no screen, may not.
 */
async function handleConnect(context: RouteContext): Promise<boolean> {
	const hit = matchRoute(context, confirmSlackConnectContract);
	if (!hit) return false;
	if (context.cliToken) {
		throw new ApiError(
			403,
			"SLACK_CONNECT_SESSION_REQUIRED",
			"Open the sign-in link from Slack in a browser signed in to ShipBash.",
		);
	}
	const { signInId } = parseParams(confirmSlackConnectContract.params, hit.raw);
	if (!(await context.options.store.linkSlackUser(context.actor, signInId))) throw expiredSignIn();
	sendContractNoContent(context.response, 204, confirmSlackConnectContract);
	return true;
}

/**
 * Slack's own refusals, in the two shapes a caller can act on: the connection
 * has stopped delivering, or Slack would not answer at all.
 */
function slackApiError(error: unknown): never {
	if (error instanceof SlackNotDeliveringError) {
		throw new ApiError(409, "SLACK_NOT_DELIVERING", error.message);
	}
	if (error instanceof SlackCallError) {
		throw new ApiError(502, "SLACK_CALL_FAILED", error.message);
	}
	throw error;
}

export async function handleAccountSlack(context: RouteContext): Promise<boolean> {
	if (await handleConnections(context)) return true;
	if (await handleUnbindChannel(context)) return true;
	try {
		if (await handleChannels(context)) return true;
		if (await handleBindChannel(context)) return true;
		if (await handleTestBinding(context)) return true;
	} catch (error) {
		slackApiError(error);
	}
	if (await handleDisconnect(context)) return true;
	if (await handleAbandonInstall(context)) return true;
	if (await handleConnectRead(context)) return true;
	if (await handleConnect(context)) return true;
	if (await handleSignIn(context)) return true;
	if (await handleSignInCallback(context)) return true;
	if (await handleInstall(context)) return true;
	return handleOAuthCallback(context);
}
