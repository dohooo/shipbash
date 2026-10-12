import { type NextRequest, NextResponse } from "next/server";

import { safeSameSitePath } from "@shipbash/contracts/same-site-path";
import { publicOrigin } from "../../../lib/public-origin";
import { publicSupabaseConfig } from "../../../lib/supabase/config";
import { withAuthState } from "../_lib";
import { routeSupabase } from "../_supabase";

export async function POST(request: NextRequest): Promise<NextResponse> {
	const nextField = (await request.formData().catch(() => null))?.get("next");
	const nextValue = typeof nextField === "string" ? nextField : null;
	// biome-ignore lint/suspicious/noImplicitAnyLet: assigned in the try block below; control flow gives it its type.
	let configuration;
	let origin: string;
	try {
		configuration = publicSupabaseConfig();
		origin = publicOrigin();
	} catch {
		return withAuthState(
			NextResponse.json(
				{ error: "GitHub sign-in is not configured." },
				{ status: 503 },
			),
		);
	}
	const requestOrigin = request.headers.get("origin");
	if (requestOrigin && requestOrigin !== origin) {
		return withAuthState(
			NextResponse.json({ error: "Invalid request origin." }, { status: 403 }),
		);
	}

	const {
		supabase,
		cookies: pendingCookies,
		headers: pendingHeaders,
	} = routeSupabase(request, origin, configuration);
	try {
		await supabase.auth.getUser();
	} catch {
		// Local sign-out still clears cookies when remote verification is unavailable.
	}
	// biome-ignore lint/suspicious/noImplicitAnyLet: assigned in the try block below; control flow gives it its type.
	let signOutError;
	try {
		({ error: signOutError } = await supabase.auth.signOut({ scope: "local" }));
	} catch {
		signOutError = new Error("Sign-out failed.");
	}
	if (signOutError) {
		return withAuthState(
			NextResponse.json(
				{ error: "Sign-out could not be completed." },
				{ status: 503 },
			),
			pendingCookies,
			pendingHeaders,
		);
	}

	// A sign-out that came from a page with somewhere to return to — the CLI
	// approval screen switching accounts — lands on the sign-in for that page.
	const next = safeSameSitePath(nextValue, "/");
	const login = new URL("/login", origin);
	if (next !== "/") login.searchParams.set("next", next);
	const response = NextResponse.redirect(login, 303);
	return withAuthState(response, pendingCookies, pendingHeaders);
}
