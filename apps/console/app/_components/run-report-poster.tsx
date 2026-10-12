"use client";

/**
 * The cover on a finished walk's recording: what the walk came to, and the one
 * thing to do about it.
 *
 * Two things, and the cover stays two things. It sits on the frame the replay
 * is about to play, because that frame is the evidence and this is the
 * sentence that reads it. At a narrow window the cover is ~180px tall, so a
 * third block is the one that pushes the failure reason off the picture — and
 * this page's credibility is carried by the recording and the checkpoints
 * under it, not by a sentence claiming it.
 *
 * The reason is the page's ONLY copy of the run's own words, so it is never
 * clamped: it scrolls inside its own box and carries the whole sentence in
 * `title`. A silently truncated failure reason is the one thing a report of a
 * failure must not do.
 */

import type { ReactNode } from "react";

import type { RunCaseView } from "@shipbash/contracts/api/view-types";

import { HandoffButton } from "./handoff-button";

/**
 * The cover's box: the scrim, and the content the host puts on it.
 *
 * The scrim is painted on the CONTENT, not on the picture — a gradient sized to
 * the frame leaves the text where it has already decayed, and the line stops
 * being readable. What goes on it differs by who is reading: an operator gets
 * the trust panel and the hand-off, an anonymous reader gets the run's sentence
 * and nothing else.
 */
function PosterFrame({ children }: { children: ReactNode }) {
  return (
    <div className="rp-poster" data-poster="1">
      <div className="rp-poster-ink">{children}</div>
    </div>
  );
}

/** The run's own words, never rewritten and never clamped. */
function PosterReason({ reason }: { reason: string }) {
  return <p className="rp-poster-desc" title={reason}>{reason}</p>;
}

export function ReportPoster({ suiteCase, onHandOff }: {
  suiteCase: RunCaseView;
  /** Hands the walk over; null where this walk offers no hand-off. */
  onHandOff: (() => Promise<boolean>) | null;
}) {
  const { detail } = suiteCase;
  const reason = detail.failureReason ?? detail.summary;
  if (!reason && !onHandOff) return null;
  return (
    <PosterFrame>
      {reason ? <PosterReason reason={reason} /> : null}
      {onHandOff ? <HandoffButton primary onCopy={onHandOff} /> : null}
    </PosterFrame>
  );
}
