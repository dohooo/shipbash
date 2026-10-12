"use client";

import { useRef } from "react";

import type { PublicVerification } from "@shipbash/contracts/api/public-verifications";
import type { BrowserLayoutState } from "./live-run-browser";
import { RunGrid, RunTimelineSkeleton } from "./live-run-layout";
import { CaseDetailSkeleton, RunCaseSkeleton } from "./live-run-panels";
import { PublicRunFrame } from "./public-run-frame";
import { PublicRunTopbarSkeleton } from "./public-run-topbar";
import { publicRunModel } from "./public-run-model";

/**
 * The shared run before its data lands. It is not a picture of the page, it IS
 * the page: the same RunGrid, driven by the run model of a verification with
 * nothing in it yet, so the rail, the workbench, its browser chrome, the
 * bottom pane and the log all come from the components that will be holding
 * the real run a moment later. Drawing a second copy of that layout here is
 * what invents a chrome the product never renders — a tab titled something
 * nobody named, a head the finished page does not have.
 *
 * The frame is the page's own (PublicRunFrame) and the bar is the run bar's
 * drawn twin, so the header and the invitation are the ones the loaded run
 * wears. The grid is inert and hidden from assistive tech, which reads the
 * status line above it instead.
 */

const RAIL_ROWS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

/** A run with nothing known about it yet; the model turns it into an empty grid. */
const PENDING_RUN: PublicVerification = {
  id: "", projectName: "", suiteName: null, sharedBy: null, sharedAt: null,
  status: "queued", verdict: null, failureReason: null,
  createdAt: "", startedAt: null, completedAt: null, eventsRunId: "", cases: [],
};

const NO_TERMINAL = { sessions: [], feed: { subscribe: () => () => undefined } };

export function PublicRunSkeleton() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  // The browser layout the run page starts every shared run from: no picture,
  // no address, and the frame's own idle placeholder carrying the wait.
  const browser: BrowserLayoutState = {
    address: "", title: "Opening the shared run", placeholderLabel: "Opening the shared run",
    canvasHidden: true, evidenceLink: false, canvasRef, frameRef,
    frameViewport: null, streamViewport: null, handbackPicture: null, streamHealth: "connecting",
  };
  return <PublicRunFrame topbar={<PublicRunTopbarSkeleton />}>
    <p className="sr-only" role="status">Loading shared run…</p>
    <div className="run-page" aria-hidden="true" inert>
      <RunGrid
        view={publicRunModel(PENDING_RUN)} log={[]} browser={browser} completed={false}
        agentPointer={null} agentSurface="browser" terminal={NO_TERMINAL}
        selectedCaseRunId={null} onSelectCase={() => undefined}
        railTally={<span className="skel-bar" data-bar="tally" />}
        railRows={RAIL_ROWS.map((key) => <RunCaseSkeleton key={key} />)}
        caseDetail={<CaseDetailSkeleton />}
        timeline={<RunTimelineSkeleton />}
      />
    </div>
  </PublicRunFrame>;
}
