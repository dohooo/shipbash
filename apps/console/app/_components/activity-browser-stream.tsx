"use client";

import { useEffect, useRef, useState } from "react";

import { safeBrowserStreamUrl } from "../../lib/client-contracts";
import type { StreamHealth, StreamViewport } from "./activity-browser-message";
import type { BrowserIdleCopy } from "./activity-browser-panes";
import { ActivityBrowserSurface, type ActivityTakeoverProps } from "./activity-browser-surface";
import { useAgentPointerFeed, type AgentPointerSignal } from "./agent-cursor";
import { useBrowserStageNotice } from "./browser-stage-notice";
import type { BrowserStreamMessage } from "./browser-viewport";
import type { BrowserPresentation } from "./browser-presentation";
import { type BrowserControlSource, useBrowserControl } from "./use-browser-control";
import { useActivityBrowserMirror } from "./use-activity-browser-mirror";
import { useActivityBrowserPresentation } from "./use-activity-browser-presentation";
import { useActivityBrowserSocket } from "./use-activity-browser-socket";
import { useFreshBrowserFrame } from "./use-fresh-browser-frame";
import { useNoVncControl } from "./use-novnc-control";
import { useBoundedStreamRecovery, useStreamResetOnAnnounce } from "./use-activity-browser-recovery";
import { useActivityBrowserSurfaces } from "./use-activity-browser-surfaces";

/**
 * The Activity's browser pane: one canvas that is a read-only mirror while the
 * agent works and the same surface, made interactive, during a takeover. The
 * socket wiring, mirrored page state (address/title/favicon/tabs), takeover
 * lease, and the dialog/file-chooser/download side channels form one
 * connection lifecycle, which is why they stay one component with the parts
 * split out beside it.
 */

/** No terminal lane listening: every message stays with the browser switch. */
const NO_TERMINAL_LANE = () => false;

interface ActivityBrowserStreamProps {
  streamUrl: string | null;
  active: boolean;
  address: string;
  reportedTitle?: string | null;
  reportedFaviconUrl?: string | null;
  finalScreenshotUrl: string | null;
  pointer?: AgentPointerSignal | null;
  /** Bump when the runner re-announces its stream (e.g. after a takeover). */
  connectionKey?: number;
  /** While the run waits for a human sign-in, the stream is intentionally
   * paused: freeze the last frame instead of dropping to a loading state. */
  waitingForAuth?: boolean;
  /** The agent has asked for a sign-in and is closing its turn; the runtime
   * goes away before the status says waiting_for_auth. The socket stays up
   * for what is left of the picture, but its going is not a loss to
   * announce: the frame stays, unbannered, until the park. */
  authPending?: boolean;
  /** The agent has finished and the runner is freezing the final frame. The
   * live stream is already closed, so this is a wrap-up state, not a connection. */
  finalizing?: boolean;
  /** Takeover turns the same canvas interactive — the mockup shell, address
   * bar, and tab strip stay exactly where the user was just watching. */
  takeover?: ActivityTakeoverProps | null;
  /** The lease for a canvas no Activity owns — the Project's sign-in takeover
   * drives this same surface through it. `takeover` wins where both are given,
   * because it carries the viewer fallback and file chooser as well. */
  control?: BrowserControlSource | null;
  /** Offered every message before the browser switch; consumes the term_*
   * types. The lane's state lives with the page (useTerminalLane) so the
   * workbench can render the Terminal tab outside this pane. */
  onTermMessage?: (message: BrowserStreamMessage) => boolean;
  /** Receives a term_input sender while this pane holds the control lease,
   * and null when it lets go — the terminal panel types through it. */
  onTermControl?: (send: ((sessionId: string, dataBase64: string) => void) | null) => void;
  /** True while a painted picture waits on its stream; drives the page pill. */
  onConnectionState?: (connecting: boolean) => void;
  /** Painted source and health facts for read-only consumers. */
  onPresentationChange?: ((presentation: BrowserPresentation) => void) | undefined;
  /** Whether this stage has been asked for a browser. Default true; only the
   * Sign-ins step passes false, before a way in is picked, for the idle stage. */
  asked?: boolean;
  transitionPhase?: "agent" | "claiming" | "controlling" | "releasing" | "error";
  frozenSnapshot?: string | null;
  onControlReady?: (() => void) | undefined;
  onControlLost?: ((reason: string) => void) | undefined;
  onFrozen?: ((snapshot: string | null) => void) | undefined;
  /**
   * What this pane says while it has no picture: the words before a stream is
   * announced, and the words once one is and nothing has painted. For a stage
   * where the Activity's own copy — a finished run with no evidence — is the
   * wrong story. Omitted, the Activity's words stand.
   */
  idleCopy?: BrowserIdleCopy;
}

/**
 * The lease this canvas runs on. An Activity takeover owns the canvas when
 * there is one, because it also carries the viewer fallback and the file
 * chooser; otherwise the page's own control source speaks for it.
 */
function controlSourceOf(
  takeover: ActivityTakeoverProps | null,
  control: BrowserControlSource | null | undefined,
): BrowserControlSource {
  const source = takeover ?? control;
  return { requested: source?.requested === true, controlToken: source?.controlToken ?? null };
}

function streamHealthOf(unavailable: boolean, ready: boolean): StreamHealth {
  if (unavailable) return "unavailable";
  return ready ? "connected" : "connecting";
}

function useActivityStreamFeed(props: ActivityBrowserStreamProps, takeoverRequested: boolean) {
  const { streamUrl, active, address, reportedTitle, reportedFaviconUrl,
    pointer = null, connectionKey = 0, waitingForAuth = false, authPending = false, finalizing = false,
    onTermMessage = NO_TERMINAL_LANE, onConnectionState, onPresentationChange,
    asked = true, finalScreenshotUrl, frozenSnapshot = null } = props;
  const mirror = useActivityBrowserMirror({ address, reportedTitle, reportedFaviconUrl });
  const safeStreamUrl = safeBrowserStreamUrl(streamUrl) ? streamUrl : null;
  const [streamViewport, setStreamViewport] = useState<StreamViewport | null>(null);
  const [frameViewport, setFrameViewport] = useState<StreamViewport | null>(null);
  const [wasDisconnected, setWasDisconnected] = useState(false);
  const [blackout, setBlackout] = useState(false);
  const surfaces = useActivityBrowserSurfaces(takeoverRequested);
  const presentationState = useActivityBrowserPresentation({
    onPresentationChange,
    setDisplayedFrame: mirror.setDisplayedFrame,
    onSourceUnavailable: () => surfaces.setControlGranted(false),
  });
  const { presentation } = presentationState;
  const sourceHealthy = presentation.transportConnected && presentation.sourceConnected;
  const recovery = useBoundedStreamRecovery({
    active, waitingForAuth, streamUrl: safeStreamUrl, sourceHealthy,
    hasFrame: frameViewport !== null, wasDisconnected,
  });
  const [hadPainted, setHadPainted] = useState(false);
  // A run that ended took its canvas with it — the completed branch stands
  // where the viewport was — so the leg that follows a wake starts on a
  // blank stage. That stage is cold, not reconnecting: the reconnect banner
  // is for a kept picture, and there is none. `resumed` tells the cold
  // placeholder to call the wait what it is.
  const [resumed, setResumed] = useState(false);
  useEffect(() => {
    if (active || !hadPainted) return;
    setHadPainted(false);
    setResumed(true);
  }, [active, hadPainted]);
  useStreamResetOnAnnounce({
    streamUrl: safeStreamUrl,
    connectionKey,
    setFrameViewport,
    setNavState: surfaces.setNavState,
    onReset: presentationState.reset,
  });
  // The stream delivers pointers ahead of the click's frame; the persisted
  // `pointer` prop is the fallback echo for reconnects and stream gaps.
  const { pointer: livePointer, applyStreamMessage, applyFallback } = useAgentPointerFeed();
  useEffect(() => {
    applyFallback(pointer);
  }, [applyFallback, pointer]);
  const { canvas: streamCanvas, canvasRef, frameRef, send } = useActivityBrowserSocket({
    streamUrl: safeStreamUrl, active, waitingForAuth, connectionKey, retryKey: recovery.retryKey,
    mirror, surfaces, presentationState, setStreamViewport, setFrameViewport,
    setWasDisconnected, setBlackout, markFramePainted: () => setHadPainted(true),
    applyStreamMessage, onTermMessage,
  });
  const freshFrame = useFreshBrowserFrame({
    active, waitingForAuth, streamUrl: safeStreamUrl, connectionKey,
    sourceHealthy, blackout,
    transportConnected: presentation.transportConnected,
    ready: presentation.ready,
    send,
    reconnectViewer: recovery.retry,
  });
  const streamHealth = streamHealthOf(
    recovery.unavailable || freshFrame.unavailable, sourceHealthy && presentation.ready,
  );
  const { notice: stageNotice } = useBrowserStageNotice({
    asked, active, frameConnected: presentation.ready, streamHealth,
    waitingForAuth: waitingForAuth || authPending, finalizing, onConnectionState,
    // A picture handed back is a kept frame: a stream that has not painted
    // yet reconnects under it rather than starting cold.
    hadPainted: hadPainted || frozenSnapshot !== null, parkedFrame: finalScreenshotUrl !== null, blackout,
  });
  return { mirror, surfaces, presentation, streamCanvas, canvasRef, frameRef, send, livePointer, streamViewport,
    frameViewport, stageNotice, freshFrame, streamAnnounced: safeStreamUrl !== null, resumed };
}

function useActivityInput(props: ActivityBrowserStreamProps, feed: ReturnType<typeof useActivityStreamFeed>,
  takeoverRequested: boolean, controlToken: string | null, phase: NonNullable<ActivityBrowserStreamProps["transitionPhase"]>) {
  const { takeover = null, onTermControl, onControlReady, onControlLost, onFrozen } = props;
  const { surfaces, presentation, streamCanvas, send } = feed;
  // A walk parked on sign-in released its runtime, so the browser behind this
  // takeover was started for the sign-in alone: there is no live stream to lay
  // control over, and its viewer is the only way in. It opens on its own rather
  // than waiting to be unfolded.
  const viewerUrl = takeoverRequested && takeover?.controlToken == null && !takeover?.preparing
    ? takeover?.fallbackViewerUrl ?? null : null;
  const noVnc = useNoVncControl(viewerUrl);
  const freezeStarted = useRef(false);
  const hadControl = useRef(false);
  const previousPhase = useRef(phase);
  useEffect(() => {
    const before = previousPhase.current;
    previousPhase.current = phase;
    if (phase === "claiming" && (before === "releasing" || before === "error") && viewerUrl) noVnc.restart();
  }, [noVnc.restart, phase, viewerUrl]);
  const controlling = useBrowserControl({
    shouldControl: takeoverRequested && controlToken !== null && phase !== "releasing",
    controlToken,
    controlGranted: surfaces.controlGranted,
    setControlGranted: surfaces.setControlGranted,
    // The relay drops a viewer's messages until its own upstream is up, so the
    // gateway's own word is what makes a claim reach the runner at all.
    gatewayConnected: presentation.ready,
    send,
    canvas: streamCanvas,
    inputEnabled: phase === "controlling" && presentation.ready,
    onTermControl,
  });
  const canvasReady = controlling && presentation.ready;
  const humanReady = viewerUrl ? noVnc.enabled : canvasReady;
  useEffect(() => {
    if (phase === "claiming" && humanReady) onControlReady?.();
  }, [humanReady, onControlReady, phase]);
  useEffect(() => {
    // Navigation hides stale pixels but does not revoke the control lease.
    const controlConnected = viewerUrl ? noVnc.enabled
      : controlling && presentation.transportConnected && presentation.sourceConnected;
    if (phase !== "controlling") { hadControl.current = false; return; }
    if (controlConnected) { hadControl.current = true; return; }
    if (hadControl.current) {
      hadControl.current = false;
      onControlLost?.(noVnc.error ?? "Browser control was interrupted. Retry to regain control.");
    }
  }, [controlling, noVnc.enabled, noVnc.error, onControlLost, phase,
    presentation.transportConnected, presentation.sourceConnected, viewerUrl]);
  useEffect(() => {
    if (phase !== "releasing") { freezeStarted.current = false; return; }
    if (freezeStarted.current) return;
    freezeStarted.current = true;
    if (viewerUrl) { void noVnc.freeze().then((snapshot) => onFrozen?.(snapshot)); return; }
    try { onFrozen?.(streamCanvas?.toDataURL("image/jpeg", 0.82) ?? null); }
    catch { onFrozen?.(null); }
  }, [noVnc.freeze, onFrozen, phase, streamCanvas, viewerUrl]);
  return { humanReady, noVnc, viewerUrl };
}

export function ActivityBrowserStream(props: ActivityBrowserStreamProps) {
  const { requested: takeoverRequested, controlToken } = controlSourceOf(props.takeover ?? null, props.control);
  const phase = props.transitionPhase ?? (takeoverRequested ? "claiming" : "agent");
  const feed = useActivityStreamFeed(props, takeoverRequested);
  const { humanReady, noVnc, viewerUrl } = useActivityInput(props, feed, takeoverRequested, controlToken, phase);
  const { active, waitingForAuth = false, finalizing = false, takeover = null,
    finalScreenshotUrl, reportedTitle, frozenSnapshot = null, idleCopy } = props;
  return (
    <ActivityBrowserSurface
      active={active} viewerUrl={viewerUrl} controlling={humanReady && phase === "controlling"}
      transitionPhase={phase} frozenSnapshot={frozenSnapshot}
      viewerRef={noVnc.frameRef} viewerReady={noVnc.enabled}
      waitingForAuth={waitingForAuth} finalizing={finalizing}
      takeoverRequested={takeoverRequested} takeover={takeover}
      finalScreenshotUrl={finalScreenshotUrl} reportedTitle={reportedTitle}
      mirror={feed.mirror} surfaces={feed.surfaces} canvasRef={feed.canvasRef} frameRef={feed.frameRef}
      pointer={feed.livePointer} streamViewport={feed.streamViewport} frameViewport={feed.frameViewport}
      stageNotice={feed.stageNotice} streamAnnounced={feed.streamAnnounced} resumed={feed.resumed}
      onRetryStream={feed.freshFrame.retry} idleCopy={idleCopy ?? null} send={feed.send}
    />
  );
}
