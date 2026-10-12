/**
 * The public CLI's sign-in. Two routes take no caller at all — the CLI files
 * its pairing request and polls for the token before it has one — and are
 * served ahead of the authenticated API (handleCliLoginRequest). The rest
 * run under an actor: the console reads and decides a request as the
 * signed-in owner; `status` and `logout` arrive with the bearer token itself.
 */
import {
	approveCliLoginContract,
	cliSessionContract,
	collectCliTokenContract,
	createCliLoginContract,
	denyCliLoginContract,
	getCliLoginContract,
	revokeCliSessionContract,
} from "@shipbash/contracts/api/cli";

import type { CliStore } from "../store/cli-store.ts";
import {
	parseBody,
	parseParams,
	sendContractJson,
	sendContractNoContent,
} from "./contracts/server.ts";
import { ApiError, type ApiRequest, type ApiResponse, requireConfigured } from "./http.ts";
import { matchRoute } from "./match-route.ts";
import type { RouteContext } from "./route-support.ts";

const SESSIONS = /^\/api\/cli\/sessions$/u;
const TOKEN = /^\/api\/cli\/sessions\/([^/]+)\/token$/u;

export const CLI_AUTHORIZE_PATH = "/cli/authorize";

/** The two routes a CLI reaches before it is anyone: true when the path was one of them. */
export function isCliLoginPath(method: string, pathname: string): boolean {
	return method === "POST" && (SESSIONS.test(pathname) || TOKEN.test(pathname));
}

export type CliLoginStore = Pick<
	CliStore,
	"createLoginRequest" | "collectToken"
>;

export async function handleCliLoginRequest(
	request: ApiRequest,
	response: ApiResponse,
	store: CliLoginStore,
): Promise<boolean> {
	const method = request.method ?? "GET";
	const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
	if (!isCliLoginPath(method, pathname)) return false;
	if (SESSIONS.test(pathname)) {
		const body = await parseBody(request, createCliLoginContract.body);
		const created = await store.createLoginRequest(body);
		sendContractJson(response, 201, createCliLoginContract, {
			...created,
			authorizePath: `${CLI_AUTHORIZE_PATH}?code=${encodeURIComponent(created.code)}`,
		});
		return true;
	}
	const { code } = parseParams(collectCliTokenContract.params, {
		code: TOKEN.exec(pathname)?.[1],
	});
	const body = await parseBody(request, collectCliTokenContract.body);
	sendContractJson(
		response,
		200,
		collectCliTokenContract,
		await store.collectToken(code, body.pollSecret),
	);
	return true;
}

function cliStore(
	context: RouteContext,
): NonNullable<RouteContext["options"]["cli"]> {
	return requireConfigured(context.options.cli, "CLI_UNAVAILABLE", "CLI sign-in is unavailable.");
}

async function handleRead(context: RouteContext): Promise<boolean> {
	const hit = matchRoute(context, getCliLoginContract);
	if (!hit) return false;
	const { code } = parseParams(getCliLoginContract.params, hit.raw);
	const found = await cliStore(context).readLoginRequest(code);
	if (!found)
		throw new ApiError(404, "CLI_LOGIN_NOT_FOUND", "That code expired.");
	sendContractJson(context.response, 200, getCliLoginContract, {
		request: found,
	});
	return true;
}

async function handleDecision(context: RouteContext): Promise<boolean> {
	const { response, actor } = context;
	const hit = matchRoute(context, approveCliLoginContract, denyCliLoginContract);
	if (!hit) return false;
	const contract = hit.route;
	const { code } = parseParams(contract.params, hit.raw);
	const decided = await cliStore(context).decideLoginRequest(
		code,
		actor.userId,
		contract === approveCliLoginContract ? "approved" : "denied",
	);
	if (!decided)
		throw new ApiError(404, "CLI_LOGIN_NOT_FOUND", "That code expired.");
	sendContractJson(response, 200, contract, { request: decided });
	return true;
}

/** `status` and `logout` speak for the token that carried them; a signed console session has none. */
function presentedToken(context: RouteContext): { id: string } {
	if (!context.cliToken)
		throw new ApiError(
			401,
			"CLI_TOKEN_REQUIRED",
			"Sign in with `shipbash login` first.",
		);
	return context.cliToken;
}

async function handleSession(context: RouteContext): Promise<boolean> {
	const { request, response, actor, options } = context;
	if (!matchRoute(context, cliSessionContract, revokeCliSessionContract)) return false;
	if (request.method === "GET") {
		const token = await cliStore(context).readToken(
			presentedToken(context).id,
			actor.userId,
		);
		if (!token)
			throw new ApiError(
				401,
				"CLI_TOKEN_REQUIRED",
				"Sign in with `shipbash login` first.",
			);
		const [current, teams] = await Promise.all([
			options.store.readCurrentUser(actor),
			options.store.listTeams(actor),
		]);
		if (!current)
			throw new ApiError(
				401,
				"CLI_TOKEN_REQUIRED",
				"Sign in with `shipbash login` first.",
			);
		const { profile } = current;
		sendContractJson(response, 200, cliSessionContract, {
			user: {
				id: profile.userId,
				displayName: profile.displayName,
				githubLogin: profile.githubLogin,
				email: profile.email,
			},
			teams: teams.map((team) => ({
				id: team.id,
				slug: team.slug,
				name: team.name,
				role: team.role,
			})),
			token: {
				client: token.client,
				device: token.device,
				createdAt: token.createdAt,
			},
		});
		return true;
	}
	if (request.method === "DELETE") {
		await cliStore(context).revokeToken(
			presentedToken(context).id,
			actor.userId,
		);
		sendContractNoContent(response, 204, revokeCliSessionContract);
		return true;
	}
	return false;
}

export async function handleCli(context: RouteContext): Promise<boolean> {
	if (!context.url.pathname.startsWith("/api/cli/")) return false;
	if (await handleRead(context)) return true;
	if (await handleDecision(context)) return true;
	return handleSession(context);
}
