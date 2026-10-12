import type { NextRequest } from "next/server";

import { githubRecovery } from "@/lib/github-recovery";
import { proxyOAuthRedirect } from "@/lib/oauth-callback-proxy";

export async function GET(request: NextRequest): Promise<Response> {
  return proxyOAuthRedirect(request, {
    path: "/api/github/oauth/callback",
    recover: (incoming) => githubRecovery(incoming, "failed"),
  });
}
