import type { NextRequest } from "next/server";

import { proxyOAuthRedirect } from "@/lib/oauth-callback-proxy";

/**
 * Leaving for Sign in with Slack is a navigation from the sign-in page, so an
 * answer that is not the redirect to Slack — no Slack app on this deployment,
 * a request it refused — lands back on that page saying to start again.
 */
export async function GET(request: NextRequest): Promise<Response> {
  return proxyOAuthRedirect(request, {
    path: "/api/slack/sign-in",
    recover: (incoming) => new URL("/slack/connect?failed=expired", incoming.nextUrl.origin),
  });
}
