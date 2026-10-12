"use client";

import { groupPublicEvents } from "@shipbash/contracts/api/public-verifications";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { publicEventLog } from "../../lib/queries";
import { webClient } from "../../lib/web-client";
import { RunEventSkeletonRows, RunTimeline } from "./live-run-layout";
import { elapsedLabel } from "./live-run-stream";


/**
 * The whole log of `runId`, the run the report names (`eventsRunId`), as the
 * operator's run page draws its own, with nothing to press for more
 * (`publicEventLog`), read again every 5 s while the run is live. The page
 * draws one timeline per run, so a retry of one Journey starting or settling
 * is another timeline, over that run's log. When a run the reader watched live
 * ends, the log is read once more for whatever the run wrote after the last
 * poll, and then left: a finished run writes nothing new. A run that had
 * already ended when the page opened arrives with its log, and is not read
 * again.
 *
 * That last read is one of its own, sent after the run ended. A poll still on
 * its way began before the run's last lines were written, so it is cancelled
 * rather than joined. (TanStack cancels only a read that has data to fall back
 * to: while the log's first read is still on its way, the catch-up joins it.)
 */
export function PublicTimeline({ token, runId, live }: { token: string; runId: string; live: boolean }) {
  const [watchedLive] = useState(live);
  const { data, isLoadingError, isPending, refetch } = useQuery({
    ...publicEventLog(webClient, token, runId),
    refetchInterval: live ? 5_000 : false,
    refetchOnWindowFocus: live,
  });
  useEffect(() => {
    if (watchedLive && !live) void refetch({ cancelRefetch: true });
  }, [watchedLive, live, refetch]);
  const events = data?.events ?? [];
  // Repeated groups merge across reads (the log so far, then each poll) without changing the raw cursor.
  return (
    <RunTimeline timelineRef={null} onTimelineScroll={() => {}} eventOrigin={new Date(0).toISOString()} neutralSystemEvents
      artifactPreview={{ artifacts: [], index: null, close: () => {}, open: () => {}, setIndex: () => {} }}
      displayedRows={groupPublicEvents(events).map((event) => ({
        event: { id: String(event.sequence), eventType: event.kind, kind: event.kind,
          level: event.level, summary: event.label, timestamp: event.createdAt, artifacts: [] },
        count: event.count, phase: "plain", durationLabel: elapsedLabel(new Date(event.elapsedMs).toISOString(), new Date(0).toISOString()),
      }))}>
      {/* A poll that fails leaves the log it has; only a first read that failed says it could not be read.
          The log reads as the operator's does: skeleton rows while it is read, and the report column's note otherwise. */}
      {isLoadingError
        ? <p className="rp-side-note" role="alert">Progress could not be loaded. <button className="button" onClick={() => void refetch()} type="button">Retry</button></p>
        : isPending ? <><p className="sr-only" role="status">Loading progress…</p><RunEventSkeletonRows /></>
          : !events.length ? <p className="rp-side-note">No progress has been recorded yet.</p> : null}
    </RunTimeline>
  );
}
