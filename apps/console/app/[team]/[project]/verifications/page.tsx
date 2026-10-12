import { redirect } from "next/navigation";
import { Suspense } from "react";

import { JourneysSkeleton } from "../../../_components/journeys-page";
import { pathWithScope } from "../../../_components/workspace-address";
import { PageFallback } from "../../_lib/page-fallback";

type VerificationsParams = { params: Promise<{ team: string; project: string }> };

async function ToJourneys({ params }: VerificationsParams) {
  const { team, project } = await params;
  return redirect(pathWithScope("/journeys", team, project));
}

/**
 * Verifications is no longer a destination: run history now hangs off the
 * journey it belongs to. Old links land on Journeys with their scope intact —
 * which the path carries; an address the session does not grant is corrected
 * there like any other.
 */
export default function VerificationsPage({ params }: VerificationsParams) {
  return <Suspense fallback={<PageFallback params={params}><JourneysSkeleton /></PageFallback>}><ToJourneys params={params} /></Suspense>;
}
