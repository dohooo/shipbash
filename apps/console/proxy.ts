import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import { isRunAddress } from "@shipbash/contracts/run-address";
import { safeSameSitePath } from "@shipbash/contracts/same-site-path";
import { configuration as deploymentConfiguration } from "@shipbash/control-plane/configuration";
import { publicOrigin, requestUsesPublicHost } from "./lib/public-origin";
import { publicSupabaseConfig } from "./lib/supabase/config";
import { isAdmitted, nonMemberMayReach } from "./lib/waitlist-gate";
import {
	sanitizeSupabaseCookieWrites,
	supabaseCookieSecurity,
} from "./lib/supabase/cookies";

function copyAuthState(
	source: NextResponse,
	target: NextResponse,
): NextResponse {
	for (const cookie of source.cookies.getAll()) target.cookies.set(cookie);
	target.headers.set(
		"cache-control",
		"private, no-cache, no-store, must-revalidate, max-age=0",
	);
	target.headers.set("expires", "0");
	target.headers.set("pragma", "no-cache");
	return target;
}

function loginRedirect(
	request: NextRequest,
	response: NextResponse,
	error?: string,
): NextResponse {
	const login = request.nextUrl.clone();
	login.pathname = "/login";
	login.search = "";
	login.searchParams.set(
		"next",
		safeSameSitePath(`${request.nextUrl.pathname}${request.nextUrl.search}`),
	);
	if (error) login.searchParams.set("error", error);
	return copyAuthState(response, NextResponse.redirect(login));
}

/**
 * 302 rather than the default 307: a POST turned away at the wall has to
 * arrive at it as a page read, not as the same POST replayed against
 * /waitlist.
 */
function gateRedirect(request: NextRequest, pathname: string): NextResponse {
	const target = request.nextUrl.clone();
	target.pathname = pathname;
	target.search = "";
	return NextResponse.redirect(target, 302);
}

/** The shared surface's bytes, which carry their own cache lifetime. */
function isPublicMediaPath(pathname: string): boolean {
	return /^\/api\/public\/verifications\/[^/]+\/media\/[^/]+\/(?:content|poster|preview|screenshot|terminal)$/u.test(
		pathname,
	);
}

function isPublicVerificationPath(pathname: string): boolean {
	return (
		// The share page and the Open Graph card an unfurl crawler fetches
		// beside it. The crawler has no session and follows no redirect to one.
		/^\/share\/verifications\/[^/]+(?:\/opengraph-image)?$/u.test(pathname) ||
		isRunCardPath(pathname) ||
		/^\/api\/public\/verifications\/[^/]+(?:\/events|\/live)?$/u.test(pathname) ||
		isPublicMediaPath(pathname)
	);
}

/**
 * A private run's card, and the page carrying it that a signed-out read of
 * the run's own address is rewritten to (signedOutResponse). `public` is a
 * reserved Team slug, so no workspace address can land here.
 */
function isRunCardPath(pathname: string): boolean {
	const card =
		/^\/public\/run-card\/([^/]+)\/([^/]+)\/([^/]+)(?:\/opengraph-image)?$/u.exec(
			pathname,
		);
	return card !== null && isRunAddress(card[1], card[2], card[3]);
}

/**
 * Where a read without a session goes: to /login, except a read of a run
 * page's own address — the link a Slack alert posts, which Slack's crawler
 * unfurls with no session and without following a redirect. That read is
 * rewritten in place to the page carrying only the run's card and a sign-in
 * link.
 */
function signedOutResponse(
	request: NextRequest,
	response: NextResponse,
): NextResponse {
	const run = /^\/([^/]+)\/([^/]+)\/verifications\/([^/]+)$/u.exec(
		request.nextUrl.pathname,
	);
	if (
		!run ||
		!isRunAddress(run[1], run[2], run[3]) ||
		(request.method !== "GET" && request.method !== "HEAD")
	) {
		return loginRedirect(request, response, "session");
	}
	const page = request.nextUrl.clone();
	page.pathname = `/public/run-card/${run[1]}/${run[2]}/${run[3]}`;
	const rewrite = copyAuthState(response, NextResponse.rewrite(page));
	rewrite.headers.set("referrer-policy", "no-referrer");
	rewrite.headers.set("x-robots-tag", "noindex, nofollow");
	return rewrite;
}

/**
 * The public CLI reaches the API without a browser session: its two sign-in
 * routes before it is anyone, and every later call with its bearer token,
 * which the API itself resolves or refuses.
 */
function isCliApiRequest(request: NextRequest): boolean {
	const { pathname } = request.nextUrl;
	if (!pathname.startsWith("/api/")) return false;
	if (
		request.method === "POST" &&
		/^\/api\/cli\/sessions(?:\/[^/]+\/token)?$/u.test(pathname)
	)
		return true;
	return (
		request.headers.get("authorization")?.startsWith("Bearer sbcli_") === true
	);
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
	if (isCliApiRequest(request)) {
		const response = NextResponse.next({ request });
		response.headers.set("cache-control", "private, no-store");
		return response;
	}
	if (isPublicVerificationPath(request.nextUrl.pathname)) {
		const response = NextResponse.next({ request });
		// Evidence bytes are content-addressed and never rewritten, so their own
		// handler sets how long a reader's browser may keep them. The rest of the
		// shared surface reads live state and stays uncached.
		if (!isPublicMediaPath(request.nextUrl.pathname)) {
			response.headers.set("cache-control", "private, no-store");
		}
		response.headers.set("referrer-policy", "no-referrer");
		response.headers.set("x-robots-tag", "noindex, nofollow");
		return response;
	}
	let configuration: ReturnType<typeof publicSupabaseConfig>;
	let origin: string;
	let waitlist: boolean;
	try {
		configuration = publicSupabaseConfig();
		origin = publicOrigin();
		waitlist = deploymentConfiguration().waitlist;
	} catch {
		return loginRedirect(
			request,
			NextResponse.next({ request }),
			"configuration",
		);
	}
	if (!requestUsesPublicHost(request, origin)) {
		const relay = request.nextUrl.clone();
		relay.pathname = "/auth/canonical";
		relay.search = "";
		relay.searchParams.set(
			"next",
			safeSameSitePath(`${request.nextUrl.pathname}${request.nextUrl.search}`),
		);
		return NextResponse.redirect(relay, 307);
	}

	// When the exact callback path is missing from the Supabase redirect
	// allowlist, GoTrue delivers the OAuth code to the project's Site URL root
	// instead. Recover by handing the code to the callback route, which owns the
	// PKCE exchange. Guarded on the in-flight verifier cookie so a stray `?code`
	// never triggers a reroute.
	if (
		request.nextUrl.searchParams.has("code") &&
		request.nextUrl.pathname !== "/cli/authorize" && // its ?code= is a pairing code, not an OAuth one
		request.cookies
			.getAll()
			.some((cookie) => cookie.name.endsWith("-auth-token-code-verifier"))
	) {
		const callback = request.nextUrl.clone();
		callback.pathname = "/auth/callback";
		return NextResponse.redirect(callback, 307);
	}

	let response = NextResponse.next({ request });
	const security = supabaseCookieSecurity(origin);
	const supabase = createServerClient(
		configuration.url,
		configuration.publishableKey,
		{
			cookieOptions: security.cookieOptions,
			cookies: {
				getAll: () => request.cookies.getAll(),
				setAll(cookies, headers) {
					const sanitized = sanitizeSupabaseCookieWrites(
						cookies,
						security.secure,
					);
					for (const cookie of sanitized)
						request.cookies.set(cookie.name, cookie.value);
					response = NextResponse.next({ request });
					for (const cookie of sanitized)
						response.cookies.set(cookie.name, cookie.value, cookie.options);
					for (const [name, value] of Object.entries(headers))
						response.headers.set(name, value);
				},
			},
		},
	);
	let data:
		| Awaited<ReturnType<typeof supabase.auth.getUser>>["data"]
		| { user: null };
	let error: unknown;
	try {
		({ data, error } = await supabase.auth.getUser());
	} catch {
		data = { user: null };
		error = new Error("User verification failed.");
	}
	if (error || !data.user) return signedOutResponse(request, response);
	// A deployment that keeps a waiting list lets in only accounts with the
	// membership claim: a reader without it meets the waiting list — and a
	// reader let in has no wall left to stand at.
	if (!isAdmitted(data.user, waitlist)) {
		if (!nonMemberMayReach(request.method, request.nextUrl.pathname)) {
			return copyAuthState(response, gateRedirect(request, "/waitlist"));
		}
	} else if (request.nextUrl.pathname === "/waitlist") {
		return copyAuthState(response, gateRedirect(request, "/"));
	}
	response.headers.set(
		"cache-control",
		"private, no-cache, no-store, must-revalidate, max-age=0",
	);
	return response;
}

export const config = {
	matcher: [
		"/((?!_next/static|_next/image|favicon.ico|favicon-16.png|favicon-32.png|favicon-48.png|apple-touch-icon.png|manifest.webmanifest|shipbash-favicon.svg|shipbash-eye.svg|google-color.svg|shipbash-eye-1024.png|shipbash-eye-transparent-1024.png|shipbash-eye-512.png|shipbash-eye-192.png|shipbash-maskable-192.png|shipbash-maskable-512.png|wterm.wasm|shipbash-brand(?:/|$)|icon(?:/|$)|login(?:/|$)|auth(?:/|$)|api/internal/schedules(?:/|$)|api/jobs(?:/|$)|api/webhooks/slack(?:/|$)|internal/waitlist(?:/|$)|shipbash-eye-mark.png|\\.well-known/workflow(?:/|$)).*)",
	],
};
