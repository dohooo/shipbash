"use client";

/**
 * The actions side of the Discovery workbench footer.
 *
 * Everything here acts on the RUN — take its browser, stop it, retry it, go
 * on from what it found. That is why stopping lives here and not above the
 * message box: a control floating over the composer reads as something you do
 * to the conversation, when it ends the walk itself.
 *
 * The footer shows only what the current state allows, so an owner never
 * reaches for a button that cannot mean anything yet.
 */
import type { ReactNode } from "react";

import { RunStopControl } from "./conversation/run-stop-control";

interface DiscoveryWorkbenchActionsProps {
  status: string;
  retryable: boolean;
  cloudflareBlocked: boolean;
  retryPending: boolean;
  onRetry: () => void;
  discoverMorePending: boolean;
  onDiscoverMore: () => void;
  draftCount: number;
  reviewHref: string | null;
  /** Null once the run can no longer be stopped — terminal, or already ending. */
  stop: { stopping: boolean; error?: string | null; onStop: () => void } | null;
}

export function DiscoveryWorkbenchActions({
  status,
  retryable,
  cloudflareBlocked,
  retryPending,
  onRetry,
  discoverMorePending,
  onDiscoverMore,
  draftCount,
  reviewHref,
  stop,
}: DiscoveryWorkbenchActionsProps): ReactNode {
  return (
    <>
      {retryable && !cloudflareBlocked ? (
        <button type="button" className="button" disabled={retryPending} onClick={onRetry}>
          {retryPending ? "Starting…" : "Retry discovery"}
        </button>
      ) : null}
      {status === "completed" ? (
        <button type="button" className="button" disabled={discoverMorePending} onClick={onDiscoverMore}>
          {discoverMorePending ? "Starting…" : "Discover more"}
        </button>
      ) : null}
      {draftCount && reviewHref ? (
        <a className="button primary" href={reviewHref} target="_blank" rel="noopener noreferrer"
          aria-label={`Review ${String(draftCount)} ${draftCount === 1 ? "draft" : "drafts"} (opens in a new tab)`}>
          Review {String(draftCount)} {draftCount === 1 ? "draft" : "drafts"}
        </a>
      ) : null}
      {stop ? (
        <RunStopControl state={stop.stopping ? "stopping" : "idle"} error={stop.error ?? null} onStop={stop.onStop} />
      ) : null}
    </>
  );
}
