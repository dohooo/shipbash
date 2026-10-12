import "server-only";

import type { ApiOptions } from "@shipbash/control-plane/api";
import { createGithubAuthenticatorGateway } from "@shipbash/control-plane/service/github-authenticator";
import {
	type SlackAlertSenderDependencies,
	sendDueSlackAlerts,
} from "@shipbash/control-plane/slack-alert-sender";
import { sweepExpiredChatState } from "@shipbash/control-plane/slack-chat/state-sweep";
import { createThreadLists } from "@shipbash/control-plane/slack-chat/thread-lists";
import { dispatchVercelSandboxWork } from "@shipbash/control-plane/vercel-sandbox-work";
import {
	createArtifactGateway,
	createBrowserRecordingGateway,
} from "@shipbash/control-plane/service/store-gateways";
import { verifyTrustedProductionAccess } from "@shipbash/control-plane/trusted-access-runtime";
import { after } from "next/server";
import { bearerToken, withActorEnvelope } from "./auth-context";
import { createProductionHumanAuthGateway } from "./production-human-auth";
import {
	getProductionRuntimeResources,
	isVercelRuntime,
	type ProductionRuntimeResources,
} from "./production-resources";
import { createProductionSignInGateways } from "./production-sign-in-takeover";
import { requireVerifiedUser } from "./supabase/server";
import {
	forwardedRequestHeaders,
	handleWebRequest,
	requestBody,
	routeNotFound,
} from "./web-adapter";

function slackAlertDependencies(
	resources: ProductionRuntimeResources,
): SlackAlertSenderDependencies {
	return {
		store: resources.store.internal,
		// The artifacts store signs the journey replays the replies carry.
		replays: resources.artifactStorage,
		publicOrigin: resources.publicBaseUrl,
	};
}

/**
 * The safety net for Slack alerts. The prompt send is the dispatch
 * workflow's own step, right after the Sandbox reports the run finished;
 * this covers a workflow that died, and the reconciler-driven finalizations
 * `dispatchVercelSandboxWork` commits. It runs from the 5-minute cron only,
 * after the dispatch: a sweep posts recordings for up to a minute, and no
 * user request should wait on that.
 */
export async function sweepProductionSlackAlerts(
	resources: ProductionRuntimeResources,
): Promise<void> {
	await sendDueSlackAlerts(slackAlertDependencies(resources));
}

/** The Slack bot's expired state; a failed sweep is logged, never the cron's answer. */
export async function sweepProductionChatState(
	resources: ProductionRuntimeResources,
): Promise<void> {
	await sweepExpiredChatState(resources.store.internal);
}

function createProductionApiOptions(
	resources: ProductionRuntimeResources,
): ApiOptions {
	const { store, artifactStorage, browserRecordingStorage } = resources;
	const onWorkAvailable = () =>
		dispatchVercelSandboxWork(store.internal, resources.workflows);
	// Signing in by hand, before any discovery: a browser in a Sandbox made
	// for the Project, and the session it captures saved as a ready way in.
	// A saved password is checked in a Sandbox of its own, after the answer.
	const signIn = createProductionSignInGateways({
		store: store.actor,
		authState: store.targetAuthState,
		takeovers: store.signInTakeovers,
		publicOrigin: resources.publicBaseUrl,
		background: (task) => after(() => task),
		onWorkAvailable,
	});
	return {
		store: store.actor,
		internal: store.internal,
		cli: store.cli,
		actorSigningSecret: resources.actorSigningSecret,
		publicBaseUrl: resources.publicBaseUrl,
		slack: resources.slack,
		github: resources.github,
		auth: createProductionHumanAuthGateway({
			store: store.actor,
			authState: store.targetAuthState,
			handoffs: store.targetAuthHandoffs,
			actorSigningSecret: resources.actorSigningSecret,
			onWorkAvailable,
		}),
		signInTakeover: signIn.takeover,
		signInVerification: signIn.verification,
		authenticators: createGithubAuthenticatorGateway({
			store: store.authenticators,
			attention: store.authAttention,
		}),
		artifacts: createArtifactGateway(store, artifactStorage),
		recordings: createBrowserRecordingGateway(store, browserRecordingStorage),
		// The header is sealed in the store under the sign-in keyring, as the
		// sign-ins are; verifying it is a request from this lambda.
		verifyTrustedAccess: verifyTrustedProductionAccess,
		onWorkAvailable,
		// A run or a walk a cancel ended before any Sandbox took it is drawn in its thread's to-do list here.
		workProgress: createThreadLists({
			store: store.internal,
			publicOrigin: resources.publicBaseUrl,
		}),
	};
}

export async function invokeProductionRequest(
	request: Request,
	pathname: string,
	userId: string,
	resources: ProductionRuntimeResources,
	trustedHeaders?: HeadersInit,
): Promise<Response> {
	const incoming = new URL(request.url);
	const target = new URL(pathname, resources.publicBaseUrl);
	target.search = incoming.search;
	const forwardedHeaders = forwardedRequestHeaders(request);
	for (const [name, value] of new Headers(trustedHeaders)) {
		forwardedHeaders.set(name, value);
	}
	const headers = withActorEnvelope(
		forwardedHeaders,
		{ userId },
		resources.actorSigningSecret,
	);
	const method = request.method.toUpperCase();
	const directRequest = new Request(target, {
		method,
		headers,
		body: await requestBody(request),
		signal: request.signal,
	});
	const response = await handleWebRequest(
		directRequest,
		createProductionApiOptions(resources),
	);
	return response ?? routeNotFound();
}

export async function handleProductionRequest(
	request: Request,
	pathname: string,
): Promise<Response> {
	if (!isVercelRuntime()) {
		throw new Error("Production requests are unavailable outside Vercel.");
	}
	const resources = getProductionRuntimeResources();
	// The public CLI names itself with its token, not a session: the token's
	// user becomes the actor, and the header rides along so the API can also
	// read and revoke the session it carries.
	const token = bearerToken(request);
	if (token !== null) {
		const identity = await resources.store.cli.resolveToken(token);
		if (!identity) {
			return Response.json(
				{
					ok: false,
					error: "AUTHENTICATION_REQUIRED",
					message: "Authentication is required.",
				},
				{ status: 401 },
			);
		}
		return invokeProductionRequest(
			request,
			pathname,
			identity.userId,
			resources,
			{
				authorization: `Bearer ${token}`,
			},
		);
	}
	const user = await requireVerifiedUser();
	return invokeProductionRequest(request, pathname, user.id, resources);
}
