import type { Metadata } from "next";

import { PageSkeleton } from "../../../_components/page-skeleton";
import { ProfilePage } from "../../../_components/team-profile";
import { WorkspacePage } from "../../_lib/workspace-page";

export const metadata: Metadata = { title: "Profile" };

/**
 * The reader's own profile. It names no product because it is about neither a
 * product nor a team — the avatar at the foot of the rail is the way in.
 */
export default function Page({ params }: { params: Promise<{ team: string }> }) {
  return (
    <WorkspacePage params={params} fallback={<PageSkeleton className="page narrow-page" title="Profile" titleHidden />}>
      <ProfilePage />
    </WorkspacePage>
  );
}
