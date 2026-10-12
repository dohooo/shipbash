import type { Metadata } from "next";

import { OverviewPage, OverviewSkeleton } from "../../_components/overview-page";
import { WorkspacePage } from "../_lib/workspace-page";

export const metadata: Metadata = { title: "Overview" };

/**
 * A team with no product. There is nothing project-scoped to address yet, so
 * this is the one workspace route whose path names only the team; the
 * workspace sends the reader on as soon as a product exists.
 */
export default function TeamPage({ params }: { params: Promise<{ team: string }> }) {
  return <WorkspacePage params={params} fallback={<OverviewSkeleton />}><OverviewPage /></WorkspacePage>;
}
