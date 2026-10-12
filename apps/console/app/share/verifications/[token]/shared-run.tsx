import { dehydrate, HydrationBoundary } from "@tanstack/react-query";

import { PublicRunUnavailable } from "../../../_components/public-run-notice";
import { PublicVerificationPage } from "../../../_components/public-verification-page";
import { shareGone } from "../../../_lib/request-errors";
import { publicEventLog } from "../../../../lib/queries";
import { makeQueryClient } from "../../../../lib/query-client";
import { serverReadQuery, serverReads } from "../../../../lib/server-client";

/**
 * The shared run, then the whole log the run names, read on the server for
 * this request and handed to the browser already answered, so the skeleton the
 * static shell paints is replaced once, by the report. The route has no
 * generateStaticParams, so it is rendered for every request: a revoked link is
 * never answered from a copy.
 *
 * A link the public API does not answer for is unavailable. A run that could
 * not be read for another reason is the share route's error, whose retry reads
 * it here again; the page is never rendered without its run. A log that could
 * not be read is left out, and the timeline reads it in the browser.
 */
export async function SharedRun({ params }: Readonly<{ params: Promise<{ token: string }> }>) {
  const { token } = await params;
  const client = makeQueryClient();
  const run = serverReadQuery("publicVerification", token);
  await client.prefetchQuery(run);
  const read = client.getQueryState(run.queryKey);
  if (shareGone(read?.error)) return <PublicRunUnavailable />;
  if (!read?.data) throw read?.error;
  await client.prefetchQuery(publicEventLog(serverReads, token, read.data.verification.eventsRunId));
  return (
    <HydrationBoundary state={dehydrate(client)}>
      <PublicVerificationPage key={token} token={token} />
    </HydrationBoundary>
  );
}
