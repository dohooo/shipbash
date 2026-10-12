import { createServerClient } from "@supabase/ssr";
import type { NextRequest } from "next/server";

import type { PublicSupabaseConfig } from "../../lib/supabase/config";
import { sanitizeSupabaseCookieWrites, supabaseCookieSecurity } from "../../lib/supabase/cookies";
import type { PendingCookie } from "./_lib";

/**
 * The Supabase client an auth route signs in or out with. The cookies and
 * headers Supabase writes collect after `seed`, for the route to set on
 * whichever answer it gives.
 */
export function routeSupabase(
  request: NextRequest,
  origin: string,
  configuration: PublicSupabaseConfig,
  seed: readonly PendingCookie[] = [],
) {
  const cookies: PendingCookie[] = [...seed];
  const headers = new Headers();
  const security = supabaseCookieSecurity(origin);
  const supabase = createServerClient(configuration.url, configuration.publishableKey, {
    cookieOptions: security.cookieOptions,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(writes, writtenHeaders) {
        cookies.push(...sanitizeSupabaseCookieWrites(writes, security.secure));
        for (const [name, value] of Object.entries(writtenHeaders)) headers.set(name, value);
      },
    },
  });
  return { supabase, cookies, headers };
}
