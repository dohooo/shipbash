import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { RunDetailPage, RunSkeleton } from "../../../../_components/run-detail";
import { route } from "../../../../_lib/route";
import { prefetchRun } from "../../../_lib/run-prefetch";
import { outsideRequestedTeam, ProductPage } from "../../../_lib/workspace-page";

interface VerificationPageProps {
  params: Promise<{ team: string; project: string; id: string }>;
  /** `?journey=` names one walk of the run: the page opens on that attempt. */
  searchParams: Promise<{ journey?: string | string[] }>;
}


export async function generateMetadata({ params }: VerificationPageProps): Promise<Metadata> {
  const { id } = await params;
  return { title: `Verification ${id}` };
}

/**
 * Where the gate stands. An evidence link is as likely to be opened by someone
 * from another team as by a member, and the shell's answer to an address it
 * cannot place is to rehome the reader into their own workspace — which drops
 * the run and says nothing. This route sends them somewhere that can explain
 * it and offer the one thing that helps: asking to be let in.
 */
function accessGateHref(team: string, project: string, runId: string): string {
  const run = `/${encodeURIComponent(team)}/${encodeURIComponent(project)}/verifications/${encodeURIComponent(runId)}`;
  return `/access/${encodeURIComponent(team)}?next=${encodeURIComponent(run)}`;
}

export default function VerificationPage({ params, searchParams }: VerificationPageProps) {
  return (
    <ProductPage
      params={params}
      fallback={<RunSkeleton />}
      prefetch={async (client, { projectId }, { id }) => {
        const { journey } = await searchParams;
        // The browser reads the first value of a repeated parameter; so does this.
        await prefetchRun(client, projectId, id, [journey].flat()[0] ?? null);
      }}
    >
      {async ({ id, team, project }, scope) => {
        if (!scope && (await outsideRequestedTeam(team))) {
          redirect(route(accessGateHref(team, project, id)));
        }
        return <RunDetailPage runId={id} />;
      }}
    </ProductPage>
  );
}
