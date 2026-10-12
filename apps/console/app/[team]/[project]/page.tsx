import type { QueryClient } from "@tanstack/react-query";
import type { Metadata } from "next";

import { OverviewPage, OverviewSkeleton } from "../../_components/overview-page";
import { stoppedActivityId } from "../../_lib/activity-derived";
import { prefetchTolerated, serverReadQuery } from "../../../lib/server-client";
import { ProductPage, type ProductScope } from "../_lib/workspace-page";

export const metadata: Metadata = { title: "Overview" };

/** The activities, then in full the exploration among them that stopped needing the reader. */
async function prefetchActivities(client: QueryClient, projectId: string) {
  const activities = serverReadQuery("activities", projectId);
  await prefetchTolerated(client, activities);
  const stopped = stoppedActivityId(client.getQueryData(activities.queryKey)?.activities ?? []);
  if (stopped) await prefetchTolerated(client, serverReadQuery("activity", projectId, stopped));
}

/**
 * Every read the Overview's first screen draws from, so the page arrives with
 * its verdict. The attention sources are read together, Slack among them: a
 * silence the reader has to wait a round trip for is a silence the page spends
 * that round trip claiming is not there.
 */
function prefetchOverview(client: QueryClient, { projectId, teamId }: ProductScope) {
  return Promise.all([
    client.prefetchQuery(serverReadQuery("overview", projectId)),
    client.prefetchQuery(serverReadQuery("journeys", projectId)),
    prefetchActivities(client, projectId),
    // Attention the Overview could not check, and a Slack state it does not
    // know, are drawn by the page itself.
    prefetchTolerated(client, serverReadQuery("authAttention", projectId)),
    prefetchTolerated(client, serverReadQuery("projectSignIns", projectId)),
    prefetchTolerated(client, serverReadQuery("slackConnections", teamId)),
  ]);
}

export default function HomePage({ params }: { params: Promise<{ team: string; project: string }> }) {
  return (
    <ProductPage params={params} fallback={<OverviewSkeleton />} prefetch={prefetchOverview}>
      <OverviewPage />
    </ProductPage>
  );
}
