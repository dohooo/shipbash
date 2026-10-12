import type { Metadata } from "next";

import { ProposalsPage, ReviewsSkeleton } from "../../../_components/reviews";
import { serverReadQuery } from "../../../../lib/server-client";
import { ProductPage } from "../../_lib/workspace-page";

export const metadata: Metadata = { title: "Reviews" };
export default function Page({ params }: { params: Promise<{ team: string; project: string }> }) {
  return (
    <ProductPage
      params={params}
      fallback={<ReviewsSkeleton />}
      prefetch={(client, { projectId }) => client.prefetchQuery(serverReadQuery("proposals", projectId))}
    >
      <ProposalsPage />
    </ProductPage>
  );
}
