import type { Metadata } from "next";

import { JourneysSkeleton, SuitesPage } from "../../../_components/journeys-page";
import { WorkspacePage } from "../../_lib/workspace-page";

export const metadata: Metadata = { title: "Journeys" };

/** The team's journeys before it has a product: the page offers to add one. */
export default function Page({ params }: { params: Promise<{ team: string }> }) {
  return <WorkspacePage params={params} fallback={<JourneysSkeleton />}><SuitesPage /></WorkspacePage>;
}
