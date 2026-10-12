"use client";

import type { Ref } from "react";

import type { StreamViewport } from "./activity-browser-message";
import { type BrowserIdleCopy, CompletedBrowserEvidence } from "./activity-browser-panes";
import { AgentCursorOverlay, type AgentPointerSignal } from "./agent-cursor";
import { BrowserMockupChrome } from "./browser-mockup-chrome";
import { type StageNotice, StageNoticeOverlays } from "./browser-stage-notice";
import { BrowserViewport, type BrowserStreamMessage } from "./browser-viewport";
import { TakeoverOverlays } from "./takeover-overlays";
import { TakeoverVeil } from "./takeover-veil";
import type { ActivityBrowserMirror } from "./use-activity-browser-mirror";
import type { BrowserControlSource } from "./use-browser-control";
import type { ActivityBrowserSurfaces } from "./use-activity-browser-surfaces";

export interface ActivityTakeoverProps extends BrowserControlSource {
  /** noVNC escape hatch for native UI the canvas cannot capture. */
  fallbackViewerUrl: string | null;
  preparing: boolean;
  error: string | null;
  onRetryPrepare?: () => void;
  /** Stores a file for the in-container file chooser; resolves the stored name. */
  uploadFile?: (file: File) => Promise<string>;
}

interface ActivityBrowserSurfaceProps {
  active: boolean;
  /** The private viewer when it is the only way in, else null (see useActivityInput). */
  viewerUrl: string | null;
  controlling: boolean;
  transitionPhase?: "agent" | "claiming" | "controlling" | "releasing" | "error";
  frozenSnapshot?: string | null;
  viewerRef?: Ref<HTMLIFrameElement>;
  viewerReady?: boolean;
  waitingForAuth: boolean;
  finalizing: boolean;
  takeoverRequested: boolean;
  takeover: ActivityTakeoverProps | null;
  finalScreenshotUrl: string | null;
  /** The title the persisted activity reports, which outranks the mirror's. */
  reportedTitle: string | null | undefined;
  mirror: ActivityBrowserMirror;
  surfaces: ActivityBrowserSurfaces;
  canvasRef: Ref<HTMLCanvasElement>;
  frameRef: Ref<HTMLDivElement>;
  pointer: AgentPointerSignal | null;
  /** The page's own size when it has reported one, else the painted frame's. */
  streamViewport: StreamViewport | null;
  frameViewport: StreamViewport | null;
  stageNotice: StageNotice;
  /** A stream address is known, so a cold stage waits on its first picture. */
  streamAnnounced: boolean;
  /** A run that already painted here ended and was woken: its cold stage is a reconnect, not a first connect. */
  resumed: boolean;
  onRetryStream: () => void;
  /** Replaces the Activity's own waiting words where they tell the wrong story. */
  idleCopy: BrowserIdleCopy | null;
  send: (message: BrowserStreamMessage) => boolean;
}

/**
 * waiting_for_auth is never terminal, so the pane is in its live branch with
 * nothing live behind it; the takeover flow keeps its own surfaces.
 */
/** The mockup shell: address, title, favicon and the mirrored tab strip. */
function ActivityBrowserChrome(props: ActivityBrowserSurfaceProps) {
  const { active, controlling, mirror, send } = props;
  return (
    <BrowserMockupChrome
      address={mirror.currentAddress}
      title={mirror.pageTitle}
      faviconUrl={mirror.faviconUrl}
      onFaviconError={() => mirror.setFaviconUrl(null)}
      tabs={active && mirror.mirroredTabs.length ? mirror.mirroredTabs : null}
      onSelectTab={controlling ? (tabId) => {
        send({ type: "tab_activate", tabId });
      } : null}
      navState={active ? props.surfaces.navState : null}
      controlling={controlling}
      onNav={(action) => send({ type: action })}
    />
  );
}

/**
 * The takeover's own overlays: how the lease is going, the dialogs the page
 * raises, its file chooser and its download notices. Each answer goes back up
 * the same socket the frames arrive on and then closes its surface.
 */
function ActivityTakeoverLayer({ controlling, releasing, takeover, surfaces, send }: {
  controlling: boolean;
  /** The reader is handing the browser back: the stream closing now is that hand-back, not an interruption. */
  releasing: boolean;
  takeover: ActivityTakeoverProps | null;
  surfaces: ActivityBrowserSurfaces;
  send: (message: BrowserStreamMessage) => boolean;
}) {
  const { controlDenied, pageDialog, dialogPromptText, fileChooserOpen, downloadNote } = surfaces;
  return (
    <TakeoverOverlays
      controlling={controlling}
      preparing={takeover?.preparing === true}
      denied={releasing ? null : controlDenied}
      error={takeover?.error ?? null}
      onRetryPrepare={takeover?.onRetryPrepare}
      dialog={pageDialog}
      dialogPromptText={dialogPromptText}
      onDialogPromptText={surfaces.setDialogPromptText}
      onDialogRespond={(accept) => {
        send({
          type: "dialog_response",
          accept,
          ...(pageDialog?.kind === "prompt" ? { promptText: dialogPromptText } : {}),
        });
        surfaces.setPageDialog(null);
      }}
      fileChooserOpen={fileChooserOpen}
      uploadFile={takeover?.uploadFile}
      onFilesChosen={(names) => {
        send({ type: "file_chosen", names });
        surfaces.setFileChooserOpen(false);
      }}
      downloadNote={downloadNote}
    />
  );
}

function privateViewerVisible(phase: ActivityBrowserSurfaceProps["transitionPhase"],
  frozenSnapshot: string | null | undefined, interactive: boolean): boolean {
  return interactive || (phase === "releasing" && !frozenSnapshot);
}

/** Layers the last safe frame under a private viewer while control changes. */
function ActivityBrowserMedia(props: ActivityBrowserSurfaceProps) {
  const viewerInteractive = Boolean(props.viewerUrl && props.viewerReady && props.controlling);
  const viewerVisible = privateViewerVisible(props.transitionPhase, props.frozenSnapshot, viewerInteractive);
  const parkedVisible = props.waitingForAuth && !viewerVisible && Boolean(props.finalScreenshotUrl);
  return <>
    {parkedVisible && props.finalScreenshotUrl ? (
      // biome-ignore lint/performance/noImgElement: runner screenshot dimensions are unknown.
      <img className="stage-picture takeover-snapshot" src={props.finalScreenshotUrl} alt="Where the agent paused" />
    ) : null}
    <iframe
      className="browser-auth-viewer"
      title="Private authentication browser"
      allow="clipboard-read; clipboard-write"
      referrerPolicy="no-referrer"
      ref={props.viewerRef}
      data-ready={String(viewerInteractive)}
      aria-hidden={!viewerInteractive}
      tabIndex={viewerInteractive ? 0 : -1}
      inert={!viewerInteractive}
      style={{ position: "absolute", inset: 0, opacity: viewerVisible ? 1 : 0,
        visibility: viewerVisible ? "visible" : "hidden", pointerEvents: viewerInteractive ? "auto" : "none" }}
    />
    {/* From the freeze until the stream paints again: the takeover's owner
        holds it only while the stream cannot show the browser. */}
    {props.frozenSnapshot ? (
      // biome-ignore lint/performance/noImgElement: ephemeral in-memory JPEG from the private viewer.
      <img className="stage-picture takeover-snapshot" src={props.frozenSnapshot} alt="Browser while handing control back" />
    ) : null}
  </>;
}

/**
 * Which notice lies over the stage's picture. Nothing while the reader holds
 * the browser, and nothing over the frozen viewer frame while control is
 * handed back, still there after a handback that failed — the veil over it
 * IS the transition. Once the handback is accepted, the picture it left is a
 * kept frame like any other, and the stream's notices stand over it.
 * Otherwise the notice stands, under the veil: a park's resting placeholder
 * takes the glass while the keys are fetched, and a real connect keeps its
 * loading line.
 */
function noticeOver(props: ActivityBrowserSurfaceProps, controlling: boolean): StageNotice {
  if (controlling) return null;
  const phase = props.transitionPhase;
  const handingBack = Boolean(props.frozenSnapshot) && (phase === "releasing" || phase === "error");
  return handingBack ? null : props.stageNotice;
}

/**
 * What stands in the browser stage, in order of precedence: the screenshot a
 * walk parked on, the private viewer when it is the only way in, the frozen
 * final frame once the run is over, and otherwise the live canvas.
 */
function ActivityBrowserStage(props: ActivityBrowserSurfaceProps) {
  const { active, controlling, takeoverRequested, finalizing } = props;
  if (!active && !takeoverRequested && !props.idleCopy
    && props.transitionPhase !== "releasing" && props.transitionPhase !== "error") {
    return <CompletedBrowserEvidence finalScreenshotUrl={props.finalScreenshotUrl} />;
  }
  const transitioning = props.transitionPhase === "claiming" || props.transitionPhase === "releasing";
  const notice = noticeOver(props, controlling);
  return (
    <BrowserViewport
      takeoverActive={controlling}
      canvasAriaLabel={controlling
        ? "Interactive ShipBash Activity browser — you are in control"
        : "Read-only ShipBash Activity browser stream"}
      canvasRef={props.canvasRef}
      frameRef={props.frameRef}
    >
      <ActivityBrowserMedia {...props} />
      {/* "cold" covers boots; a pane that HAS painted keeps its last frame —
          banner and status pill say the view is away. Rendered under the veil
          so a park's resting placeholder takes the handoff's glass too. */}
      <StageNoticeOverlays
        notice={notice}
        finalizing={finalizing}
        streamAnnounced={props.streamAnnounced}
        resumed={props.resumed}
        idleCopy={props.idleCopy}
        onRetry={props.onRetryStream}
      />
      <TakeoverVeil active={transitioning} />
      <AgentCursorOverlay
        pointer={props.pointer}
        viewport={props.streamViewport ?? props.frameViewport}
        turnKey="activity"
        visible={active && props.frameViewport !== null && !controlling}
      />
      {takeoverRequested ? (
        <ActivityTakeoverLayer
          controlling={controlling}
          releasing={props.transitionPhase === "releasing"}
          takeover={props.takeover}
          surfaces={props.surfaces}
          send={props.send}
        />
      ) : null}
    </BrowserViewport>
  );
}

/** Everything the Activity's browser pane paints, from its connection state. */
export function ActivityBrowserSurface(props: ActivityBrowserSurfaceProps) {
  const { active, controlling } = props;
  return (
    <section
      className="activity-browser browser-mockup"
      aria-label={active ? "Live Activity browser" : "Activity browser result"}
      data-human={controlling ? "true" : undefined}
    >
      <ActivityBrowserChrome {...props} />
      <div className="browser-stage">
        <ActivityBrowserStage {...props} />
      </div>
    </section>
  );
}
