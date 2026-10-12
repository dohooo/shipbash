import "server-only";

import { sessionContract } from "@shipbash/contracts/api/account";
import type { NextRequest } from "next/server";

import { serverLoad } from "./server-client";

/**
 * Where a GitHub redirect that could not be finished lands. The control plane
 * sends the browser back to the pane it left whenever it still knows which
 * one that was; when it does not — a state that expired, was spent, or names
 * nobody — the reader's own active team names the pane instead. The reason
 * travels either way, because the pane is what can explain it.
 */
export async function githubRecovery(request: NextRequest, reason: string): Promise<URL> {
  const pane = (pathname: string): URL => {
    const recovery = new URL(pathname, request.nextUrl.origin);
    recovery.searchParams.set("github", reason);
    return recovery;
  };
  try {
    const session = await serverLoad(sessionContract, { query: {} });
    const team = session.teams.find((candidate) => candidate.id === session.activeTeamId) ?? session.teams[0];
    return team ? pane(`/${encodeURIComponent(team.slug)}/settings/github`) : pane("/");
  } catch {
    return pane("/");
  }
}
