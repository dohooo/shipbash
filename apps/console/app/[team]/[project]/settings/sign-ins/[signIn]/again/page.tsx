import type { Metadata } from "next";

import { SignInAddSkeleton, SignInAgainPage } from "../../../../../../_components/sign-in-add-page";
import { serverReadQuery } from "../../../../../../../lib/server-client";
import { ProductPage } from "../../../../../_lib/workspace-page";

export const metadata: Metadata = { title: "Sign in again" };
export default function Page({ params }: { params: Promise<{ team: string; project: string; signIn: string }> }) {
  return (
    <ProductPage
      params={params}
      fallback={<SignInAddSkeleton title="Sign in again" />}
      prefetch={(client, { projectId }) => client.prefetchQuery(serverReadQuery("projectSignIns", projectId))}
    >
      {({ signIn }) => <SignInAgainPage signInId={signIn} />}
    </ProductPage>
  );
}
