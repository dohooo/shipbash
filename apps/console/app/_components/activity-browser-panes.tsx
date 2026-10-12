"use client";

/**
 * The Activity browser pane's still pictures and copy: what stands in for the
 * live canvas when there is nothing live behind it (parked on sign-in,
 * completed, connecting). The socket lifecycle stays in
 * activity-browser-stream, and the message-shaping helpers in
 * activity-browser-message.
 */

import { useCallback, useState } from "react";

import { BrowserIdlePlaceholder } from "./browser-idle-placeholder";

/** The mockup tab's name before the mirrored page reports one. */
export function fallbackTitleFor(address: string): string {
  try {
    return new URL(address).hostname;
  } catch {
    return "Product";
  }
}

/**
 * What a stage with nothing to show yet says, for a pane where the Activity's
 * own words are the wrong story: the Sign-ins step is opening a browser, not
 * reporting on a run that finished without evidence. A pane that passes none
 * keeps the Activity's copy.
 */
export interface BrowserIdleCopy {
  /**
   * The heading over the at-rest placeholder, where the default "Nothing open
   * yet" tells the wrong story — a stage resting after its work is done has
   * nothing still to come.
   */
  title?: string;
  /** Nothing has asked for a browser yet: the empty-stage placeholder's line. */
  empty: string;
  /** No stream announced yet, so there is nothing to dial. */
  beforeStream: string;
  /** Dialled, and no picture has arrived down it yet. */
  beforeFirstFrame: string;
}

/** The empty-stage line for a surface with no words of its own for it. */
export const DEFAULT_EMPTY = "The browser opens here when something needs one.";

/** The shimmering title of a cold stage: the wrap-up, a woken run's reconnect, or a first connect. */
export function connectingCopy(finalizing: boolean, resumed = false): string {
  if (finalizing) return "Finishing up…";
  return resumed ? "Reconnecting…" : "Connecting browser…";
}

/** The line under the shimmering title: what the wait is, in the order it happens. The wrap-up needs none — its title already says it. */
export function connectingDetail(streamAnnounced: boolean, finalizing: boolean): string | null {
  if (finalizing) return null;
  return streamAnnounced ? "The first picture is on its way." : "The sandbox is waking up and opening a browser.";
}

/**
 * What stands in for the live canvas once the run is over: the frozen final
 * frame the sidecar captured just before teardown. Discovery keeps no video —
 * the journey lane owns recordings — so this single screenshot is the
 * Activity's durable browser evidence.
 *
 * The picture is a layer over the placeholder in the live stage's own frame:
 * until it arrives it paints nothing and the placeholder shows through, so the
 * stage keeps one size. A picture that does not load is dropped, which leaves
 * the placeholder at rest rather than a broken image.
 */
export function CompletedBrowserEvidence({ finalScreenshotUrl }: { finalScreenshotUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  // Hydration attaches React's listeners without replaying an error the
  // browser met before them, so the mount looks once: a picture that is
  // complete with no width failed.
  const broken = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth === 0) setFailed(true);
  }, []);
  const picture = failed ? null : finalScreenshotUrl;
  return (
    <div className="browser-frame">
      {picture
        // At rest, not working: under a picture that has arrived, a shine would
        // keep repainting where nobody sees it.
        ? <BrowserIdlePlaceholder title="Loading the last picture…" copy={null} covered />
        : <BrowserIdlePlaceholder copy="No browser picture to show." />}
      {picture ? (
        // biome-ignore lint/performance/noImgElement: a runner-captured screenshot behind the session cookie, which next/image's optimizer would fetch server-side without.
        <img
          ref={broken}
          className="stage-picture"
          src={picture}
          alt="Final browser state captured by ShipBash"
          onError={() => setFailed(true)}
        />
      ) : null}
    </div>
  );
}
