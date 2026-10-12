import type { Metadata } from "next";

import { JourneysSkeleton, SuitesPage } from "../../../_components/journeys-page";
import { prefetchTolerated, serverReadQuery } from "../../../../lib/server-client";
import { ProductPage } from "../../_lib/workspace-page";

export const metadata: Metadata = { title: "Journeys" };
export default function JourneysPage({ params }: { params: Promise<{ team: string; project: string }> }) {
  return (
    <ProductPage params={params} fallback={<JourneysSkeleton />} prefetch={(client, { teamId, projectId }) => Promise.all([
      client.prefetchQuery(serverReadQuery("journeys", projectId)),
      // The exploring strip, the sign-in banner and the month's Runs beside
      // Run now leave themselves out when their read fails.
      prefetchTolerated(client, serverReadQuery("activities", projectId)),
      prefetchTolerated(client, serverReadQuery("verifications", projectId)),
      prefetchTolerated(client, serverReadQuery("runAllowance", teamId)),
    ])}>
      <SuitesPage />
    </ProductPage>
  );
}
