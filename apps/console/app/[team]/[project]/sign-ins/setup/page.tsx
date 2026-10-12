import type { Metadata } from "next";

import { SignInSetupPage, SignInSetupSkeleton } from "../../../../_components/sign-in-setup-page";
import { serverReadQuery } from "../../../../../lib/server-client";
import { ProductPage } from "../../../_lib/workspace-page";

export const metadata: Metadata = { title: "Sign-ins" };
export default function Page({ params }: { params: Promise<{ team: string; project: string }> }) {
  return (
    <ProductPage
      params={params}
      fallback={<SignInSetupSkeleton />}
      prefetch={(client, { projectId }) => client.prefetchQuery(serverReadQuery("projectSignIns", projectId))}
    >
      <SignInSetupPage />
    </ProductPage>
  );
}
