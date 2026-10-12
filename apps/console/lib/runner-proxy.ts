import "server-only";

import { WAITLIST_ADMIN_HEADER } from "@shipbash/contracts/api/waitlist";
import { configuration } from "@shipbash/control-plane/configuration";

import { bearerToken, withActorEnvelope } from "./auth-context";
import {
	getProductionRuntimeResources,
	isVercelRuntime,
} from "./production-resources";
import {
	handleProductionRequest,
	invokeProductionRequest,
} from "./production-runtime";
import { waitlistAdminApiOptions } from "./production-waitlist";
import { requireVerifiedUser } from "./supabase/server";
import {
	forwardedRequestHeaders,
	handleWebRequest,
	requestBody,
	routeNotFound,
} from "./web-adapter";

const FORWARDED_RESPONSE_HEADERS = [
	"cache-control",
	"accept-ranges",
	"content-disposition",
	"content-length",
	"content-range",
	"content-security-policy",
	"content-type",
	"location",
	"retry-after",
	"x-accel-buffering",
] as const;

export function runnerOrigin(): string {
	const value = process.env.SHIPBASH_RUNNER_URL ?? "http://127.0.0.1:4174";
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("SHIPBASH_RUNNER_URL must be an HTTP(S) URL.");
	}
	return url.origin;
}

async function authenticatedRunnerHeaders(
	input?: HeadersInit,
): Promise<Headers> {
	const user = await requireVerifiedUser();
	return withActorEnvelope(input, { userId: user.id }, configuration().actorSigningSecret);
}

/**
 * A POST to the API as an account a trusted route has just verified, such as a
 * sign-in callback, whose session the request's own cookies do not carry yet.
 */
async function postAsAccount(
	pathname: string,
	userId: string,
): Promise<Response> {
	if (isVercelRuntime()) {
		const resources = getProductionRuntimeResources();
		return invokeProductionRequest(
			new Request(new URL(pathname, resources.publicBaseUrl), {
				method: "POST",
			}),
			pathname,
			userId,
			resources,
		);
	}
	return fetch(new URL(pathname, runnerOrigin()), {
		method: "POST",
		headers: withActorEnvelope(undefined, { userId }, configuration().actorSigningSecret),
		cache: "no-store",
		redirect: "error",
		signal: AbortSignal.timeout(5_000),
	});
}

/**
 * Brings the account a sign-in has just verified into existence before its
 * first page — profile, personal team, the team its company domain joins it
 * to — so the proxy in front of that page already sees the result.
 */
export async function startAccountSession(userId: string): Promise<void> {
	const response = await postAsAccount("/api/session", userId);
	await response.body?.cancel();
	if (!response.ok) throw new Error("The account could not be started.");
}

/**
 * The internal waiting list's way to the API.
 *
 * Every other call from here names an account — a signed actor envelope, or a
 * CLI token the API resolves. This one cannot: there is no account behind the
 * shared password, so it carries the password in a header the route itself
 * checks and never asks for a session. The API dispatches that lane before it
 * identifies a caller, which is what makes an actorless request answerable at
 * all.
 */
export async function proxyWaitlistAdminRequest(
	pathname: string,
	init: { method: string; body?: string | undefined },
	password: string,
): Promise<Response> {
	const headers: Record<string, string> = {
		accept: "application/json",
		"content-type": "application/json",
		[WAITLIST_ADMIN_HEADER]: password,
	};
	if (isVercelRuntime()) {
		const resources = getProductionRuntimeResources();
		const request = new Request(new URL(pathname, resources.publicBaseUrl), {
			method: init.method,
			headers,
			body: init.body ?? null,
		});
		return (
			(await handleWebRequest(request, waitlistAdminApiOptions(resources))) ??
			routeNotFound()
		);
	}
	return fetch(new URL(pathname, runnerOrigin()), {
		method: init.method,
		headers,
		body: init.body ?? null,
		cache: "no-store",
		redirect: "error",
	});
}

export async function proxyRunnerRequest(
	request: Request,
	pathname: string,
): Promise<Response> {
	if (isVercelRuntime()) {
		return handleProductionRequest(request, pathname);
	}
	const incomingUrl = new URL(request.url);
	const target = new URL(pathname, runnerOrigin());
	target.search = incomingUrl.search;

	const forwardedHeaders = forwardedRequestHeaders(request);
	const token = bearerToken(request);
	const headers =
		token === null
			? await authenticatedRunnerHeaders(forwardedHeaders)
			: new Headers([
					...forwardedHeaders,
					["authorization", `Bearer ${token}`],
				]);

	const method = request.method.toUpperCase();
	const body = await requestBody(request);
	const upstream = await fetch(target, {
		method,
		headers,
		body,
		cache: "no-store",
		redirect: "manual",
		signal: request.signal,
	});

	const responseHeaders = new Headers();
	for (const name of FORWARDED_RESPONSE_HEADERS) {
		const value = upstream.headers.get(name);
		if (value !== null) responseHeaders.set(name, value);
	}
	responseHeaders.set("cache-control", "no-store");
	responseHeaders.set("x-content-type-options", "nosniff");

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: responseHeaders,
	});
}
