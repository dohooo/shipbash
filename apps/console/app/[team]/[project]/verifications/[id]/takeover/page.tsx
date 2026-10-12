import type { Metadata } from "next";

import { RunTakeoverSession } from "../../../../../_components/run-takeover-session";
import { TakeoverPageSkeleton } from "../../../../../_components/takeover-page-skeleton";
import { serverReadQuery } from "../../../../../../lib/server-client";
import { ProductPage } from "../../../../_lib/workspace-page";

interface TakeoverPageProps {
  params: Promise<{ team: string; project: string; id: string }>;
}

export async function generateMetadata({ params }: TakeoverPageProps): Promise<Metadata> {
  const { id } = await params;
  return { title: `Take control · ${id}` };
}

/** Taking control of a run's browser is drawn on the Activity page's stage, so it waits on it too. */
export default function TakeoverPage({ params }: TakeoverPageProps) {
  return (
    <ProductPage
      params={params}
      fallback={<TakeoverPageSkeleton />}
      prefetch={(client, { projectId }, { id }) => client.prefetchQuery(serverReadQuery("verification", projectId, id))}
    >
      {({ id }) => <RunTakeoverSession runId={id} />}
    </ProductPage>
  );
}
