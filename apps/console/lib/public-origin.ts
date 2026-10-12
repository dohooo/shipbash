import { configuration } from "@shipbash/control-plane/configuration";
import type { NextRequest } from "next/server";

/** The origin the console is served on, as the deployment's configuration names it; throws when that is incomplete. */
export function publicOrigin(): string {
	return configuration().publicUrl;
}

/** Whether the request reached that origin's host, or names no host at all. */
export function requestUsesPublicHost(
	request: NextRequest,
	origin: string,
): boolean {
	const requestHost =
		request.headers.get("x-forwarded-host") ?? request.headers.get("host");
	return (
		!requestHost ||
		requestHost.toLowerCase() === new URL(origin).host.toLowerCase()
	);
}
