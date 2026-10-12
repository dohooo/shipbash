import type { QueryClient } from "@tanstack/react-query";

import { earlierWalk } from "../../_lib/run-report";
import { prefetchTolerated, serverReadQuery } from "../../../lib/server-client";

/**
 * What a run's page shows first, read on the server before it renders.
 *
 * The run, files included, and alongside it what only the report reads —
 * what waits on the owner and the open questions — which is read for a live
 * run too, so it never waits on the run. Once the run is read, the earlier
 * walk a `?journey=` link names, when the run does not already show it.
 *
 * The run is the page's main read, so its failure is the route's error. The
 * page is still worth drawing without any of the others — an attention it
 * could not check, the questions, the walk — so they are tolerated: left for
 * the browser to read again.
 *
 * The run's auth status is not read here: reading it starts the sign-in
 * session it reports on, so only the browser asks for it. Nor is its log: a
 * run's log runs to thousands of lines, which would weigh the page's HTML
 * down by a megabyte. The page draws its log's pending rows, and the browser
 * reads the log once the page is up (`verificationLog`).
 */
export async function prefetchRun(
  client: QueryClient,
  projectId: string,
  runId: string,
  journey: string | null,
): Promise<void> {
  const runRead = serverReadQuery("verification", projectId, runId);
  const run = client.prefetchQuery(runRead).then(() => {
    const view = client.getQueryData(runRead.queryKey)?.view;
    const walk = view ? earlierWalk(view, journey) : null;
    return walk ? prefetchTolerated(client, serverReadQuery("verification", projectId, runId, walk)) : undefined;
  });
  await Promise.all([
    run,
    prefetchTolerated(client, serverReadQuery("authAttention", projectId, runId)),
  ]);
}
