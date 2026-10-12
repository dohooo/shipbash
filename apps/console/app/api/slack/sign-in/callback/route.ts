import type { NextRequest } from "next/server";

import { proxyOAuthRedirect } from "@/lib/oauth-callback-proxy";

/**
 * Slack's redirect back from Sign in with Slack. The control plane lands every
 * ending it can name on the sign-in page; anything else — no session, no Slack
 * app, Slack or the Runner not answering — lands there too, saying to start
 * again.
 */
export async function GET(request: NextRequest): Promise<Response> {
  return proxyOAuthRedirect(request, {
    path: "/api/slack/sign-in/callback",
    recover: (incoming) => new URL("/slack/connect?failed=expired", incoming.nextUrl.origin),
  });
}
