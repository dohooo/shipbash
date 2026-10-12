import type { Metadata } from "next";
import { Suspense } from "react";

import { PublicRunSkeleton } from "../../../_components/public-run-skeleton";
import { SharedRun } from "./shared-run";

const TITLE = "Shared verification";
const DESCRIPTION = "A ShipBash verification run: real user journeys, walked in a real browser.";

// The card beside this copy carries the run's own numbers; `opengraph-image`
// in this segment supplies it and the og:image tags that point at it. Staying
// noindex keeps the link unlisted — unfurl crawlers read og tags regardless.
export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  robots: { index: false, follow: false },
  openGraph: { title: TITLE, description: DESCRIPTION, siteName: "ShipBash", type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

type SharePageProps = {
  params: Promise<{ token: string }>;
};

export default function SharedVerification(props: SharePageProps) {
  return (
    <Suspense fallback={<PublicRunSkeleton />}>
      <SharedRun {...props} />
    </Suspense>
  );
}
