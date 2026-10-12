import { sessionContract } from "@shipbash/contracts/api/account";
import type { NextRequest } from "next/server";

import { proxyOAuthRedirect } from "@/lib/oauth-callback-proxy";
import { serverLoad } from "@/lib/server-client";

/**
 * Where to send someone whose install could not be finished. The control plane
 * sends them back to the pane they left whenever it still knows which one that
 * was; by the time it does not — a state that expired, was already spent, or
 * belongs to nobody — the team is unknowable from the redirect alone, so the
 * reader's own default team names the pane instead. The notice travels either
 * way, because the pane is what can explain it.
 */
async function slackRecovery(request: NextRequest): Promise<URL> {
  const notice = (pathname: string): URL => {
    const recovery = new URL(pathname, request.nextUrl.origin);
    recovery.searchParams.set("slack", "failed");
    return recovery;
  };
  try {
    const session = await serverLoad(sessionContract, { query: {} });
    const team =
      session.teams.find((candidate) => candidate.id === session.activeTeamId) ?? session.teams[0];
    return team ? notice(`/${encodeURIComponent(team.slug)}/settings/slack`) : notice("/");
  } catch {
    return notice("/");
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  return proxyOAuthRedirect(request, {
    path: "/api/slack/oauth/callback",
    recover: slackRecovery,
  });
}
