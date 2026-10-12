import type { Metadata } from "next";

import { NewJourneyPage } from "../../../../_components/new-journey-page";
import { PageSkeleton } from "../../../../_components/page-skeleton";
import { ProductPage } from "../../../_lib/workspace-page";

export const metadata: Metadata = { title: "New journey" };
export default function Page({ params }: { params: Promise<{ team: string; project: string }> }) {
  return (
    <ProductPage params={params} fallback={<PageSkeleton className="page describe-page" />}>
      <NewJourneyPage />
    </ProductPage>
  );
}
