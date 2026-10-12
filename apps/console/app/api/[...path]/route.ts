import {
	handleCliLoginWebRequest,
	isCliLoginRequest,
} from "@/lib/cli-login-handler";
import { isVercelRuntime } from "@/lib/production-resources";
import { proxyRunnerRequest } from "@/lib/runner-proxy";
import { routeNotFound } from "@/lib/web-adapter";

type RouteContext = { params: Promise<{ path: string[] }> };

// A saved password's check settles after the answer (`after`): a browser
// Sandbox, then up to the leg's three minutes. Fluid's default, stated here
// so a lower project default cannot cut a check short.
export const maxDuration = 300;

async function proxy(request: Request, context: RouteContext) {
	const { path } = await context.params;
	const pathname = `/api/${path.map(encodeURIComponent).join("/")}`;
	// `shipbash login` files and polls its pairing request before it has a session.
	if (isCliLoginRequest(request, pathname)) {
		return handleCliLoginWebRequest(request, pathname);
	}
	if (isVercelRuntime()) {
		return proxyRunnerRequest(request, pathname);
	}
	if (
		![
			"session",
			"invitations",
			"profile",
			"teams",
			"team-access",
			"github",
			"slack",
			"projects",
			"case-runs",
			"activities",
			"cli",
			"waitlist",
		].includes(path[0] ?? "")
	) {
		return routeNotFound();
	}
	return proxyRunnerRequest(request, pathname);
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
