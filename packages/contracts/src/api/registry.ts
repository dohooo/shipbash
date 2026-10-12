/** Machine-readable census for every public API boundary. */
import * as account from "./account.ts";
import * as activities from "./activities.ts";
import * as auth from "./auth.ts";
import * as authenticators from "./authenticators.ts";
import * as cli from "./cli.ts";
import type { AnyApiContract, ApiMethod } from "./core.ts";
import * as github from "./github.ts";
import * as journeys from "./journeys.ts";
import { matchApiPath } from "./path-match.ts";
import * as projects from "./projects.ts";
import * as proposals from "./proposals.ts";
import * as publicVerifications from "./public-verifications.ts";
import * as runs from "./runs.ts";
import * as signInTakeover from "./sign-in-takeover.ts";
import * as signInVerification from "./sign-in-verification.ts";
import * as signIns from "./sign-ins.ts";
import * as slack from "./slack.ts";
import * as streams from "./streams.ts";
import * as teamAccess from "./team-access.ts";
import * as trustedAccess from "./trusted-access.ts";
import * as waitlist from "./waitlist.ts";

const contractModules = [
	account,
	activities,
	auth,
	authenticators,
	cli,
	github,
	journeys,
	projects,
	proposals,
	publicVerifications,
	runs,
	signInTakeover,
	signInVerification,
	signIns,
	slack,
	streams,
	teamAccess,
	trustedAccess,
	waitlist,
];

function isApiContract(value: unknown): value is AnyApiContract {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"method" in value &&
		typeof value.method === "string" &&
		"path" in value &&
		typeof value.path === "string" &&
		"successStatuses" in value &&
		Array.isArray(value.successStatuses)
	);
}

export const publicApiContracts = contractModules
	.flatMap((module) => Object.values(module).filter(isApiContract))
	.sort((left, right) => left.id.localeCompare(right.id));

export type PublicApiExceptionKind =
	| "binary"
	| "oauth"
	| "redirect"
	| "sse";

export interface PublicApiTransportException {
	method: ApiMethod;
	path: string;
	kind: PublicApiExceptionKind;
	reason: string;
}

/** Non-JSON public routes. Adding one requires a named transport and rationale. */
export const publicApiTransportExceptions: readonly PublicApiTransportException[] =
	[
		{
			method: "GET",
			path: streams.activityEventsContract.path,
			kind: "sse",
			reason: "Streams validated Activity event frames.",
		},
		{
			method: "GET",
			path: streams.runEventsContract.path,
			kind: "sse",
			reason: "Streams validated Verification event frames.",
		},
		{
			method: "GET",
			path: "/api/github/app-manifest/callback",
			kind: "oauth",
			reason: "Completes GitHub App creation and redirects the browser.",
		},
		{
			method: "GET",
			path: "/api/github/installations/callback",
			kind: "oauth",
			reason: "Records GitHub App installation setup and redirects the browser to GitHub's authorization.",
		},
		{
			method: "GET",
			path: "/api/github/oauth/callback",
			kind: "oauth",
			reason: "Completes connecting GitHub from the App authorization and redirects the browser.",
		},
		{
			method: "GET",
			path: "/api/slack/install",
			kind: "oauth",
			reason: "Starts a Slack workspace install and redirects the browser to Slack.",
		},
		{
			method: "GET",
			path: "/api/slack/oauth/callback",
			kind: "oauth",
			reason: "Completes a Slack workspace install and redirects the browser.",
		},
		{
			method: "GET",
			path: "/api/slack/sign-in",
			kind: "oauth",
			reason: "Starts a Slack user's Sign in with Slack and redirects the browser to Slack.",
		},
		{
			method: "GET",
			path: "/api/slack/sign-in/callback",
			kind: "oauth",
			reason: "Completes a Slack user's Sign in with Slack and redirects the browser to its confirm page.",
		},
		{
			method: "GET",
			path: "/api/projects/:projectId/verifications/:runId/artifacts/:artifactId",
			kind: "binary",
			reason: "Returns or redirects to an immutable Verification artifact.",
		},
		{
			method: "GET",
			path: "/api/case-runs/:caseRunId/evidence.zip",
			kind: "binary",
			reason: "Streams the evidence of one walk's Journey, with the run's overview, as one zip.",
		},
		{
			method: "GET",
			path: "/api/activities/:activityId/evidence.zip",
			kind: "binary",
			reason: "Streams the evidence of a walk or a Discovery, with its conversation and outcome, as one zip.",
		},
		{
			method: "GET",
			path: "/api/public/verifications/:token/live",
			kind: "sse",
			reason:
				"Streams only sanitized live frames for an enabled suite_run share after every request is authorized.",
		},
		{
			method: "GET",
			path: "/api/public/verifications/:token/media/:id/:kind",
			kind: "binary",
			reason:
				"Streams only media belonging to an enabled suite_run share after every request is authorized.",
		},
		{
			method: "GET",
			path: "/api/projects/:projectId/activities/:activityId/final-screenshot",
			kind: "binary",
			reason: "Returns or redirects to the final browser screenshot.",
		},
		{
			method: "GET",
			path: "/api/projects/:projectId/activities/:activityId/terminal-logs/:sessionId",
			kind: "binary",
			reason: "Returns a retained terminal session log as NDJSON.",
		},
		{
			method: "GET",
			path: "/api/projects/:projectId/browser-recordings/:recordingId/content",
			kind: "redirect",
			reason: "Redirects to signed browser recording content media.",
		},
		{
			method: "GET",
			path: "/api/projects/:projectId/browser-recordings/:recordingId/poster",
			kind: "redirect",
			reason: "Redirects to signed browser recording poster media.",
		},
	];

export function apiPathMatches(template: string, pathname: string): boolean {
	return matchApiPath(template, pathname) !== null;
}

export function isDeclaredPublicApiRoute(
	method: string,
	pathname: string,
): boolean {
	return (
		publicApiContracts.some(
			(contract) =>
				contract.method === method && apiPathMatches(contract.path, pathname),
		) ||
		publicApiTransportExceptions.some(
			(exception) =>
				exception.method === method && apiPathMatches(exception.path, pathname),
		)
	);
}
