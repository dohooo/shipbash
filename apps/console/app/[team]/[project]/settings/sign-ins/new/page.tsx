import type { Metadata } from "next";

import { SignInAddPage, SignInAddSkeleton } from "../../../../../_components/sign-in-add-page";
import { serverReadQuery } from "../../../../../../lib/server-client";
import { ProductPage } from "../../../../_lib/workspace-page";

export const metadata: Metadata = { title: "Add a way in" };
export default function Page({ params }: { params: Promise<{ team: string; project: string }> }) {
  return (
    <ProductPage
      params={params}
      fallback={<SignInAddSkeleton />}
      prefetch={(client, { projectId }) => client.prefetchQuery(serverReadQuery("projectSignIns", projectId))}
    >
      <SignInAddPage />
    </ProductPage>
  );
}
