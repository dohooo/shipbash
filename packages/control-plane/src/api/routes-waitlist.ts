/**
 * The waiting list's doors, in two lanes that share nothing but a path prefix.
 *
 * The reader's lane is an ordinary actor route family under `/api/waitlist`,
 * and it answers only what the reader told us. The internal lane under
 * `/api/waitlist/internal` has no actor at all — there is no account behind
 * the shared password it is authorized by — so it is dispatched before the
 * caller is ever identified, the way the CLI's pairing routes are. The same
 * lane lists every team's usage this month and sets a team's Run quota.
 */
import {
	decideWaitlistRequestContract,
	joinWaitlistContract,
	listTeamUsageContract,
	listWaitlistRequestsContract,
	setTeamRunQuotaContract,
	WAITLIST_ADMIN_HEADER,
	waitlistStandingContract,
} from "@shipbash/contracts/api/waitlist";
import { matchApiPath } from "@shipbash/contracts/api/path-match";

import type { ApiOptions } from "../api.ts";
import { sameSecret } from "../same-secret.ts";
import { usageCostUsd } from "../usage-cost.ts";
import {
	parseBody,
	parseParams,
	sendContractJson,
	sendContractNoContent,
} from "./contracts/server.ts";
import { WaitlistMailError } from "./gateways.ts";
import {
	ApiError,
	type ApiRequest,
	type ApiResponse,
	headerValue,
} from "./http.ts";
import type { RouteContext } from "./route-support.ts";

/** The site as we will store it, or null when it is not an address we can reach. */
function absoluteHttpUrl(value: string): string | null {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	return url.hostname ? url.href : null;
}

export async function handleWaitlist(context: RouteContext): Promise<boolean> {
	const { url, request, response, actor, options } = context;
	if (url.pathname !== "/api/waitlist") return false;
	if (request.method !== "GET" && request.method !== "POST") return false;
	if (request.method === "GET") {
		sendContractJson(response, 200, waitlistStandingContract, {
			request: await options.store.readWaitlistStanding(actor),
		});
		return true;
	}
	const body = await parseBody(request, joinWaitlistContract.body);
	// Judged here rather than in the store, because the verdict the reader gets
	// is a status code, and the form must get the same one with scripting off.
	const site = absoluteHttpUrl(body.site);
	if (!site) {
		throw new ApiError(
			422,
			"INVALID_SITE",
			"That is not an address we can reach. Give the full one, starting with https://.",
		);
	}
	sendContractJson(
		response,
		201,
		joinWaitlistContract,
		await options.store.joinWaitlist(actor, { email: body.email, site }),
	);
	return true;
}

function assertWaitlistAdmin(request: ApiRequest, options: ApiOptions): void {
	const configured = options.waitlistAdminPassword?.trim();
	if (!configured) {
		throw new ApiError(
			503,
			"WAITLIST_ADMIN_UNAVAILABLE",
			"The internal waiting list is not configured.",
		);
	}
	if (
		!sameSecret(headerValue(request, WAITLIST_ADMIN_HEADER) ?? "", configured)
	) {
		throw new ApiError(
			401,
			"AUTHENTICATION_REQUIRED",
			"Authentication is required.",
		);
	}
}

async function applyDecision(
	options: ApiOptions,
	userId: string,
	action: "shelve" | "unshelve" | "admit",
): Promise<void> {
	if (action !== "admit") {
		await options.internal.setWaitlistShelved(userId, action === "shelve");
		return;
	}
	const mailer = options.waitlistMailer;
	if (!mailer) {
		throw new ApiError(
			503,
			"WAITLIST_MAIL_UNAVAILABLE",
			"Letting someone in needs a mailer, and none is configured.",
		);
	}
	try {
		await options.internal.admitWaitlistRequest(userId, (admitted) =>
			mailer.sendAdmission({ email: admitted.email, site: admitted.site }),
		);
	} catch (error) {
		// The admission has already rolled back with the send. Say why, so the
		// internal page shows what stopped it instead of a bare 500 whose only
		// account of itself is in the server log.
		if (error instanceof WaitlistMailError) {
			throw new ApiError(502, "WAITLIST_MAIL_FAILED", error.message);
		}
		throw error;
	}
}

/** One internal route: what the request is answered with, given its path's raw segments. */
interface InternalRoute {
	contract: { readonly method: string; readonly path: string };
	handle: (
		raw: Record<string, string>,
		request: ApiRequest,
		response: ApiResponse,
		options: ApiOptions,
	) => Promise<void>;
}

const INTERNAL_ROUTES: readonly InternalRoute[] = [
	{
		contract: listWaitlistRequestsContract,
		handle: async (_raw, _request, response, options) => {
			sendContractJson(response, 200, listWaitlistRequestsContract, {
				requests: await options.internal.listWaitlistRequests(),
			});
		},
	},
	{
		contract: decideWaitlistRequestContract,
		handle: async (raw, request, response, options) => {
			const { userId } = parseParams(decideWaitlistRequestContract.params, raw);
			const { action } = await parseBody(
				request,
				decideWaitlistRequestContract.body,
			);
			await applyDecision(options, userId, action);
			sendContractNoContent(response, 204, decideWaitlistRequestContract);
		},
	},
	{
		// Every team's month, its usage priced as it is read.
		contract: listTeamUsageContract,
		handle: async (_raw, _request, response, options) => {
			const teams = await options.internal.listTeamUsage();
			sendContractJson(response, 200, listTeamUsageContract, {
				teams: teams.map(({ usage, ...team }) => ({
					...team,
					costThisMonthUsd: usageCostUsd(usage),
				})),
			});
		},
	},
	{
		contract: setTeamRunQuotaContract,
		handle: async (raw, request, response, options) => {
			const { teamId } = parseParams(setTeamRunQuotaContract.params, raw);
			const { monthlyRunQuota } = await parseBody(
				request,
				setTeamRunQuotaContract.body,
			);
			if (!(await options.internal.setTeamRunQuota(teamId, monthlyRunQuota))) {
				throw new ApiError(404, "TEAM_NOT_FOUND", "Team was not found.");
			}
			sendContractNoContent(response, 204, setTeamRunQuotaContract);
		},
	},
];

function internalRoute(
	method: string,
	pathname: string,
): { route: InternalRoute; raw: Record<string, string> } | null {
	for (const route of INTERNAL_ROUTES) {
		if (route.contract.method !== method) continue;
		const raw = matchApiPath(route.contract.path, pathname);
		if (raw) return { route, raw };
	}
	return null;
}

export function isWaitlistInternalPath(
	method: string,
	pathname: string,
): boolean {
	return internalRoute(method, pathname) !== null;
}

export async function handleWaitlistInternalRequest(
	url: URL,
	request: ApiRequest,
	response: ApiResponse,
	options: ApiOptions,
): Promise<void> {
	assertWaitlistAdmin(request, options);
	const hit = internalRoute(request.method ?? "GET", url.pathname);
	if (!hit) throw new ApiError(404, "NOT_FOUND", "Route not found.");
	await hit.route.handle(hit.raw, request, response, options);
}
