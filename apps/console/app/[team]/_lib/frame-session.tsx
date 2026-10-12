import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { Suspense, type ReactNode } from "react";

import { resolveScope } from "../../_components/workspace-address";
import { makeQueryClient } from "../../../lib/query-client";
import { prefetchTolerated, serverReadQuery } from "../../../lib/server-client";

/**
 * The session a part of the frame, or a pending page's head, reads, answered
 * on the server so it renders knowing whose workspace this is. The request
 * reads it once, however many boundaries ask, and each boundary carries its
 * own copy to the browser: a few kilobytes against a boundary that waits on
 * nothing else. A session the server cannot read is not handed over, so the
 * parts keep their placeholders until the browser reads it; the page reports
 * a failure.
 *
 * The run limit bar's boundary also reads the team's Runs this month, so a
 * page load draws the bar, or leaves it out, without a read in the browser;
 * a read that fails leaves the bar out until the browser reads it.
 */
async function FrameSession({ params, runAllowance = false, children }: Readonly<{
  params: Promise<{ team: string }>;
  runAllowance?: boolean;
  children: ReactNode;
}>) {
  const { team } = await params;
  const client = makeQueryClient();
  const session = serverReadQuery("session", team);
  await client.prefetchQuery(session);
  const granted = runAllowance ? client.getQueryData(session.queryKey) : undefined;
  const resolved = granted ? resolveScope(granted, team, null) : null;
  if (resolved) await prefetchTolerated(client, serverReadQuery("runAllowance", resolved.team.id));
  return <HydrationBoundary state={dehydrate(client)}>{children}</HydrationBoundary>;
}

/**
 * How a frame draws a part that reads the session (`withSession`): in a
 * boundary of its own over this request's session, with `placeholder` until
 * it is read.
 */
export function sessionBoundary(params: Promise<{ team: string }>) {
  return (parts: ReactNode, placeholder: ReactNode, runAllowance = false) => (
    <Suspense fallback={placeholder}>
      <FrameSession params={params} runAllowance={runAllowance}>{parts}</FrameSession>
    </Suspense>
  );
}
