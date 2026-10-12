import "server-only";

import {
	handleCliLoginRequest,
	isCliLoginPath,
} from "@shipbash/control-plane/api/routes-cli";

import {
	getProductionRuntimeResources,
	isVercelRuntime,
} from "./production-resources";
import { runnerOrigin } from "./runner-proxy";
import { invokeWebHandler, routeNotFound } from "./web-adapter";

/** The two CLI sign-in routes a caller reaches before it is anyone. */
export function isCliLoginRequest(request: Request, pathname: string): boolean {
	return isCliLoginPath(request.method.toUpperCase(), pathname);
}

export async function handleCliLoginWebRequest(
	request: Request,
	pathname: string,
): Promise<Response> {
	if (isVercelRuntime()) {
		const resources = getProductionRuntimeResources();
		const response = await invokeWebHandler(
			request,
			(adaptedRequest, adaptedResponse) =>
				handleCliLoginRequest(
					adaptedRequest,
					adaptedResponse,
					resources.store.cli,
				),
		);
		if (response) return response;
		return routeNotFound();
	}
	const incoming = new URL(request.url);
	const target = new URL(pathname, runnerOrigin());
	target.search = incoming.search;
	const upstream = await fetch(target, {
		method: request.method,
		headers: {
			"content-type": request.headers.get("content-type") ?? "application/json",
			accept: "application/json",
		},
		body: await request.arrayBuffer(),
		cache: "no-store",
		redirect: "manual",
		signal: request.signal,
	});
	const headers = new Headers();
	const contentType = upstream.headers.get("content-type");
	if (contentType) headers.set("content-type", contentType);
	headers.set("cache-control", "no-store");
	return new Response(upstream.body, { status: upstream.status, headers });
}
