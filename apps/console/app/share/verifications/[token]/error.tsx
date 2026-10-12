"use client";

import { PublicRunFailed } from "../../../_components/public-run-notice";
import { useRouteRetry } from "../../../_components/route-error";

/**
 * A shared run the server could not read. It wears the share page's own
 * frame rather than the workspace's error, whose recoveries (a sign-out, a
 * scope reset) are for a signed-in reader; trying again reads it again.
 */
export default function SharedRunError({ retry }: Readonly<{ error: Error & { digest?: string }; retry: () => void }>) {
  return <PublicRunFailed retry={useRouteRetry(retry)} />;
}
