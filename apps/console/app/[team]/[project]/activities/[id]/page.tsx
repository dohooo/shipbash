import type { Metadata } from "next";
import { cookies } from "next/headers";

import { ActivityPage, PendingActivityPage } from "../../../../_components/activity-page";
import { storedActivityLayouts } from "../../../../_lib/activity-layout";
import { serverReadQuery } from "../../../../../lib/server-client";
import { ProductPage } from "../../../_lib/workspace-page";

export const metadata: Metadata = { title: "Activity" };
/**
 * The reader's layout choices are read with the request, inside the page's
 * boundary where its reads already wait on the request, so the page is drawn
 * on the server in the layout the browser keeps.
 */
export default function Page({ params }: { params: Promise<{ team: string; project: string; id: string }> }) {
  return (
    <ProductPage
      params={params}
      fallback={<PendingActivityPage />}
      prefetch={(client, { projectId }, { id }) => client.prefetchQuery(serverReadQuery("activity", projectId, id))}
    >
      {async ({ id }) => <ActivityPage activityId={id} storedLayouts={storedActivityLayouts((await cookies()).getAll())} />}
    </ProductPage>
  );
}
