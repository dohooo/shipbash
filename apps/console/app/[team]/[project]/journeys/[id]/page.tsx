import type { Metadata } from "next";

import { JourneyPage, JourneySkeleton } from "../../../../_components/journey-detail-page";
import { prefetchTolerated, serverReadQuery } from "../../../../../lib/server-client";
import { ProductPage } from "../../../_lib/workspace-page";

export const metadata: Metadata = { title: "Journey" };
export default function Page({ params }: { params: Promise<{ team: string; project: string; id: string }> }) {
  return (
    <ProductPage params={params} fallback={<JourneySkeleton />} prefetch={(client, { projectId }) => Promise.all([
      client.prefetchQuery(serverReadQuery("journeys", projectId)),
      // The Journey is drawn without its run history when that cannot be read.
      prefetchTolerated(client, serverReadQuery("verifications", projectId)),
    ])}>
      {({ id }) => <JourneyPage journeyId={id} />}
    </ProductPage>
  );
}
