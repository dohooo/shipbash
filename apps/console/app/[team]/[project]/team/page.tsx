import type { Metadata } from "next";

import { TeamPage, TeamSkeleton } from "../../../_components/team-profile";
import { serverReadQuery } from "../../../../lib/server-client";
import { ProductPage } from "../../_lib/workspace-page";

export const metadata: Metadata = { title: "Team" };
export default function Page({ params }: { params: Promise<{ team: string; project: string }> }) {
  return (
    <ProductPage params={params} fallback={<TeamSkeleton />} prefetch={(client, { teamId }) => client.prefetchQuery(serverReadQuery("team", teamId))}>
      <TeamPage />
    </ProductPage>
  );
}
