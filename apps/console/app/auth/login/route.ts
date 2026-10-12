import type { NextRequest, NextResponse } from "next/server";

import { safeSameSitePath } from "@shipbash/contracts/same-site-path";
import { publicOrigin, requestUsesPublicHost } from "../../../lib/public-origin";
import { publicSupabaseConfig } from "../../../lib/supabase/config";
import { AUTH_NEXT_COOKIE, AUTH_PROVIDER_COOKIE, loginPage, type PendingCookie, redirectResponse } from "../_lib";
import { routeSupabase } from "../_supabase";

const AUTH_NEXT_MAX_AGE_SECONDS = 10 * 60;

/**
 * What each way in asks its provider for. Google's `openid` makes it return an
 * ID token, whose `hd` claim names a Google Workspace domain; `select_account`
 * lets someone signed in to several Google accounts pick the work one.
 */
const PROVIDERS = {
  github: { scopes: "read:user" },
  google: { scopes: "openid", queryParams: { prompt: "select_account" } },
} as const;

function requestedProvider(request: NextRequest): keyof typeof PROVIDERS | null {
  const provider = request.nextUrl.searchParams.get("provider");
  return provider === "github" || provider === "google" ? provider : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestedNext = safeSameSitePath(request.nextUrl.searchParams.get("next"));
  const next = requestedNext.length <= 2_048 ? requestedNext : "/";
  const provider = requestedProvider(request);
  // A link that names no way in, such as the waitlist's admission email, asks
  // the reader to choose one.
  if (!provider) return loginPage(request, next);
  const loginError = (code: string) => loginPage(request, next, { code, provider });
  let origin: string;
  try {
    origin = publicOrigin();
  } catch {
    return loginError("configuration");
  }
  if (!requestUsesPublicHost(request, origin)) {
    return redirectResponse(new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, origin));
  }

  // biome-ignore lint/suspicious/noImplicitAnyLet: assigned in the try block below; control flow gives it its type.
  let configuration;
  try {
    configuration = publicSupabaseConfig();
  } catch {
    return loginError("configuration");
  }

  const callbackCookie: PendingCookie["options"] = {
    httpOnly: true,
    maxAge: AUTH_NEXT_MAX_AGE_SECONDS,
    path: "/auth/callback",
    sameSite: "lax",
    secure: new URL(origin).protocol === "https:",
  };
  const attemptCookies: PendingCookie[] = [
    { name: AUTH_NEXT_COOKIE, value: Buffer.from(next, "utf8").toString("base64url"), options: callbackCookie },
    { name: AUTH_PROVIDER_COOKIE, value: provider, options: callbackCookie },
  ];
  const { supabase, cookies: pendingCookies, headers: pendingHeaders } = routeSupabase(
    request,
    origin,
    configuration,
    attemptCookies,
  );
  const callback = new URL("/auth/callback", origin);
  // biome-ignore lint/suspicious/noImplicitAnyLet: assigned in the try block below; control flow gives it its type.
  let oauthResult;
  try {
    oauthResult = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        ...PROVIDERS[provider],
        redirectTo: callback.toString(),
        skipBrowserRedirect: true,
      },
    });
  } catch {
    return loginError("oauth");
  }
  const { data, error } = oauthResult;
  if (error || !data.url) return loginError("oauth");

  let authorizationUrl: URL;
  try {
    authorizationUrl = new URL(data.url);
  } catch {
    return loginError("oauth");
  }
  if (
    authorizationUrl.origin !== new URL(configuration.url).origin ||
    authorizationUrl.pathname !== "/auth/v1/authorize"
  ) {
    return loginError("oauth");
  }
  return redirectResponse(authorizationUrl, pendingCookies, pendingHeaders);
}
