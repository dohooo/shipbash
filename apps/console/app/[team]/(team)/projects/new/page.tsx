import type { Metadata } from "next";

import { PageSkeleton } from "../../../../_components/page-skeleton";
import { AddProjectPage } from "../../../../_components/project";
import { WorkspacePage } from "../../../_lib/workspace-page";

export const metadata: Metadata = { title: "Add project" };

/** Adding a product is a team action, so its address never names one. */
export default function Page({ params }: { params: Promise<{ team: string }> }) {
  return <WorkspacePage params={params} fallback={<PageSkeleton />}><AddProjectPage /></WorkspacePage>;
}
