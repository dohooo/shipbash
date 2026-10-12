"use client";

import type { ReactNode } from "react";

import type { BrowserIdleCopy } from "./activity-browser-panes";
import { ActivityBrowserStream } from "./activity-browser-stream";
import type { BrowserPresentation } from "./browser-presentation";
import type { TakeoverPhase } from "./use-activity-takeover-transition";

/**
 * Nothing has been asked of a browser until the reader picks a way in, so the
 * Activity's own no-stream words — a finished run that captured no evidence —
 * read here as a browser that failed to open. Both lines say the same thing
 * the stage is actually doing: waiting, first on the browser and then on its
 * first picture.
 */
const IDLE_COPY: BrowserIdleCopy = {
  empty: "Pick a way in and the browser opens here.",
  beforeStream: "Opening the browser…",
  beforeFirstFrame: "Waiting for the first picture…",
};

/**
 * The same stage once a bind has ticked. The browser it was signed in through
 * has been handed back, so the stage is at rest again — but asking a reader who
 * has just finished to pick a way in is the wrong thing to end on.
 *
 * Only `empty` is ever read here: a finished bind stops asking for a browser,
 * which is what puts the stage in its at-rest state to begin with.
 */
export const SIGNED_IN_COPY: BrowserIdleCopy = {
  ...IDLE_COPY,
  title: "Signed in",
  empty: "This way in is saved and ready for this project.",
};

/**
 * The browser this step works in. The canvas is the Activity's own component,
 * so the rules its stage and frame rely on come with it: stretching the
 * component alone leaves the page floating at its intrinsic ratio with dead
 * ground above and below, because those rules are scoped to a page this step
 * is not inside. `.auth-work-stage` is that same pair, in this step's scope.
 *
 * The stream keeps the browser's own ratio, and the box is sized by it — the
 * same `--browser-aspect` the activity page's live browser follows — so the
 * stage is exactly as tall as the picture and nothing is stretched or banded;
 * the rail beside it scrolls within that height.
 *
 * `data-takeover-active` is the runner's answer, never this page's ask: it
 * paints the amber human-control ring, so it is true only while a human really
 * is driving.
 */
export function SignInBrowser({ streamUrl, controlToken, requested, address, asked, idleCopy = IDLE_COPY,
  onDrive, phase = "agent", snapshot = null, onControlReady, onControlLost, onFrozen, onPresentationChange, children }: {
  streamUrl: string | null;
  controlToken: string | null;
  /** Whether this canvas is asking to drive at all. */
  requested: boolean;
  address: string;
  /** Whether a bind is holding the browser. While none is, the stage is at rest. */
  asked: boolean;
  /** What the stage says at rest — the question by default, `SIGNED_IN_COPY` after a tick. */
  idleCopy?: BrowserIdleCopy | undefined;
  /** Told the first time the reader actually drives — the signal that something is now losable. */
  onDrive: () => void;
  phase?: TakeoverPhase;
  snapshot?: string | null;
  onControlReady?: () => void;
  onControlLost?: (reason: string) => void;
  onFrozen?: (image: string | null) => void;
  onPresentationChange?: (presentation: BrowserPresentation) => void;
  children?: ReactNode;
}) {
  return (
    <div
      className="auth-work-stage"
      onPointerDownCapture={phase === "controlling" ? onDrive : undefined}
      onKeyDownCapture={phase === "controlling" ? onDrive : undefined}
    >
      <ActivityBrowserStream
        streamUrl={streamUrl}
        active={Boolean(streamUrl)}
        address={address}
        asked={asked}
        finalScreenshotUrl={null}
        control={{ requested, controlToken }}
        transitionPhase={phase}
        frozenSnapshot={snapshot}
        onControlReady={onControlReady}
        onControlLost={onControlLost}
        onFrozen={onFrozen}
        onPresentationChange={onPresentationChange}
        idleCopy={idleCopy}
      />
      {children}
    </div>
  );
}
