import type { CookieOptions } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

/** Where a sign-in was headed, kept for the callback while the provider has the reader. */
export const AUTH_NEXT_COOKIE = "shipbash-auth-next";

/** Which way in a sign-in took, so the callback can name it if the sign-in fails. */
export const AUTH_PROVIDER_COOKIE = "shipbash-auth-provider";

export interface PendingCookie {
  name: string;
  value: string;
  options: CookieOptions;
}

/** Sets the cookies and headers a route collected, then keeps the answer out of every cache. */
export function withAuthState(
  response: NextResponse,
  cookies: readonly PendingCookie[] = [],
  headers: Headers = new Headers(),
): NextResponse {
  for (const cookie of cookies) response.cookies.set(cookie.name, cookie.value, cookie.options);
  for (const [name, value] of headers) response.headers.set(name, value);
  response.headers.set("cache-control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("expires", "0");
  response.headers.set("pragma", "no-cache");
  return response;
}

export function redirectResponse(
  location: URL,
  cookies: readonly PendingCookie[] = [],
  headers: Headers = new Headers(),
): NextResponse {
  return withAuthState(NextResponse.redirect(location, 303), cookies, headers);
}

/** Back to the sign-in page; with a failure, it names the way in that failed. */
export function loginPage(
  request: NextRequest,
  next: string,
  failure?: { code: string; provider: string },
  cookies: readonly PendingCookie[] = [],
  headers: Headers = new Headers(),
): NextResponse {
  const url = new URL("/login", request.nextUrl.origin);
  url.searchParams.set("next", next);
  if (failure) {
    url.searchParams.set("error", failure.code);
    url.searchParams.set("provider", failure.provider);
  }
  return redirectResponse(url, cookies, headers);
}
