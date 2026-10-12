import { safeSameSitePath } from "@shipbash/contracts/same-site-path";
import type { NextRequest } from "next/server";

import { proxyOAuthRedirect } from "@/lib/oauth-callback-proxy";

/**
 * Leaving for Slack is a navigation too, so it gets the same treatment as the
 * redirect back: a deployment with no Slack app must return the admin to the
 * pane with a reason, not leave them looking at a 503 body. This one knows
 * where they came from — the address is already in its own query.
 */
export async function GET(request: NextRequest): Promise<Response> {
  return proxyOAuthRedirect(request, {
    path: "/api/slack/install",
    recover: (incoming) => {
      const recovery = new URL(
        safeSameSitePath(incoming.nextUrl.searchParams.get("return")),
        incoming.nextUrl.origin,
      );
      recovery.searchParams.set("slack", "unavailable");
      return recovery;
    },
  });
}
