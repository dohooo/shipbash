import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest, NextResponse } from "next/server";

import { safeSameSitePath } from "@shipbash/contracts/same-site-path";
import { publicOrigin } from "../../../lib/public-origin";
import { startAccountSession } from "../../../lib/runner-proxy";
import { publicSupabaseConfig } from "../../../lib/supabase/config";
import { AUTH_NEXT_COOKIE, AUTH_PROVIDER_COOKIE, loginPage, type PendingCookie, redirectResponse } from "../_lib";
import { routeSupabase } from "../_supabase";

const ENCODED_NEXT_PATTERN = /^[A-Za-z0-9_-]{1,2731}$/u;

/** Where the sign-in was headed and which way in it took, as the login route left them. */
interface Attempt {
  next: string;
  provider: string;
}

function loginError(
  request: NextRequest,
  attempt: Attempt,
  code: string,
  cookies: readonly PendingCookie[] = [],
  headers: Headers = new Headers(),
): NextResponse {
  return loginPage(request, attempt.next, { code, provider: attempt.provider }, cookies, headers);
}

function providerFromCookie(request: NextRequest): string {
  return request.cookies.get(AUTH_PROVIDER_COOKIE)?.value === "google" ? "google" : "github";
}

function nextFromCookie(request: NextRequest): string {
  const encoded = request.cookies.get(AUTH_NEXT_COOKIE)?.value;
  if (!encoded || !ENCODED_NEXT_PATTERN.test(encoded)) return "/";
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const next = safeSameSitePath(decoded);
    return next.length <= 2_048 ? next : "/";
  } catch {
    return "/";
  }
}

function clearedAttemptCookies(request: NextRequest): PendingCookie[] {
  const options: PendingCookie["options"] = {
    httpOnly: true,
    maxAge: 0,
    path: "/auth/callback",
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
  };
  return [
    { name: AUTH_NEXT_COOKIE, value: "", options },
    { name: AUTH_PROVIDER_COOKIE, value: "", options },
  ];
}

async function signedOutError(
  supabase: Pick<SupabaseClient, "auth">,
  request: NextRequest,
  attempt: Attempt,
  code: string,
  cookies: readonly PendingCookie[],
  headers: Headers,
): Promise<NextResponse> {
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // The fixed error redirect remains safe even when remote sign-out is unavailable.
  }
  return loginError(request, attempt, code, cookies, headers);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const next = nextFromCookie(request);
  const attempt = { next, provider: providerFromCookie(request) };
  const cleared = clearedAttemptCookies(request);
  if (request.nextUrl.searchParams.has("error")) {
    return loginError(request, attempt, "oauth", cleared);
  }
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return loginError(request, attempt, "callback", cleared);

  // biome-ignore lint/suspicious/noImplicitAnyLet: assigned in the try block below; control flow gives it its type.
  let configuration;
  let origin: string;
  try {
    configuration = publicSupabaseConfig();
    origin = publicOrigin();
  } catch {
    return loginError(request, attempt, "configuration", cleared);
  }

  const { supabase, cookies: pendingCookies, headers: pendingHeaders } = routeSupabase(
    request,
    origin,
    configuration,
    cleared,
  );
  // biome-ignore lint/suspicious/noImplicitAnyLet: assigned in the try block below; control flow gives it its type.
  let exchangeError;
  try {
    ({ error: exchangeError } = await supabase.auth.exchangeCodeForSession(code));
  } catch {
    return loginError(request, attempt, "callback", pendingCookies, pendingHeaders);
  }
  if (exchangeError) return loginError(request, attempt, "callback", pendingCookies, pendingHeaders);

  // biome-ignore lint/suspicious/noImplicitAnyLet: assigned in the try block below; control flow gives it its type.
  let userData;
  // biome-ignore lint/suspicious/noImplicitAnyLet: assigned in the try block below; control flow gives it its type.
  let userError;
  try {
    ({ data: userData, error: userError } = await supabase.auth.getUser());
  } catch {
    userData = { user: null };
    userError = new Error("User verification failed.");
  }
  if (userError || !userData.user) {
    return signedOutError(supabase, request, attempt, "session", pendingCookies, pendingHeaders);
  }
  // The first page must already see what the account is: on a first sign-in
  // its company domain may have joined it to a team, and let it in.
  try {
    await startAccountSession(userData.user.id);
  } catch {
    return signedOutError(supabase, request, attempt, "account", pendingCookies, pendingHeaders);
  }
  return redirectResponse(new URL(next, origin), pendingCookies, pendingHeaders);
}
