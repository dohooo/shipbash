import type { Metadata } from "next";

import { ProposalPage, ProposalSkeleton } from "../../../../_components/proposal-review-page";
import { serverReadQuery } from "../../../../../lib/server-client";
import { ProductPage } from "../../../_lib/workspace-page";

export const metadata: Metadata = { title: "Review" };
export default function Page({ params }: { params: Promise<{ team: string; project: string; id: string }> }) {
  return (
    <ProductPage
      params={params}
      fallback={<ProposalSkeleton />}
      prefetch={(client, { projectId }, { id }) => client.prefetchQuery(serverReadQuery("proposal", projectId, id))}
    >
      {({ id }) => <ProposalPage proposalId={id} />}
    </ProductPage>
  );
}
