import type { Metadata } from "next";

import { TeamPage, TeamSkeleton } from "../../../_components/team-profile";
import { serverReadQuery } from "../../../../lib/server-client";
import { WorkspacePage } from "../../_lib/workspace-page";

export const metadata: Metadata = { title: "Team" };

/** Who is on the team, which has nothing to do with having a product. */
export default function Page({ params }: { params: Promise<{ team: string }> }) {
  return (
    <WorkspacePage params={params} fallback={<TeamSkeleton />} prefetch={(client, { teamId }) => client.prefetchQuery(serverReadQuery("team", teamId))}>
      <TeamPage />
    </WorkspacePage>
  );
}
