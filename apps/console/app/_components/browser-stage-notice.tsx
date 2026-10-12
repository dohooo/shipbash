import { useEffect } from "react";

import { type BrowserIdleCopy, connectingCopy, connectingDetail, DEFAULT_EMPTY } from "./activity-browser-panes";
import { BrowserIdlePlaceholder } from "./browser-idle-placeholder";

export type StageNotice = "idle" | "parked" | "cold" | "reconnecting" | "unavailable" | "blackout" | null;

/**
 * What the browser stage says about its connection. "idle" is the brand
 * placeholder at rest — nothing has asked for a browser here, so there is
 * nothing to connect and no motion. "cold" is the same placeholder working:
 * the pane has never shown a picture (or is finalizing, where the copy
 * explains the pause), and its title shines while the browser is opened.
 * "reconnecting" keeps the last frame on the canvas and only adds the
 * slim banner: a re-announced stream or a wobbling gateway is a pause in the
 * SAME story, not a new blank page. A stage waiting on a sign-in keeps
 * whatever picture it has — the live frame or the park's screenshot — with
 * nothing over it: the header pill and the status line already say why the
 * walk paused, and the reader is about to take that very browser over. With
 * no picture at all it is "parked": the brand placeholder with the sign-in
 * words, at rest — nothing is connecting, the reader is what comes next.
 */
function browserStageNotice(input: {
  /** Whether this stage has been asked for a browser. Absent = true. */
  asked?: boolean | undefined;
  hadFrame: boolean;
  /** A parked walk's last screenshot stands in for a painted frame. */
  parkedFrame?: boolean | undefined;
  frameConnected: boolean;
  blackout?: boolean;
  streamHealth: "connected" | "connecting" | "unavailable" | null;
  waitingForAuth: boolean;
  finalizing: boolean;
}): StageNotice {
  // Idle precedes connection: unasked is not a connection state, and handing
  // the browser back returns the stage here even if a frame once painted.
  if (input.asked === false) return "idle";
  if (input.waitingForAuth) return input.hadFrame || input.parkedFrame === true ? null : "parked";
  if (input.blackout && !input.finalizing) return "blackout";
  if (!input.finalizing && input.streamHealth === "unavailable") return "unavailable";
  if (!input.frameConnected) {
    if (input.finalizing || !input.hadFrame) return "cold";
    return "reconnecting";
  }
  if (!input.finalizing && input.streamHealth === "connecting") {
    return "reconnecting";
  }
  return null;
}

/**
 * The stage notice as pane state: remembers that a frame has EVER painted
 * (deliberately surviving stream re-announces, so the canvas keeps its last
 * picture and the stage reconnects quietly), and reports the reconnecting
 * state up — the page flips its status pill to Connecting on that signal.
 */
export function useBrowserStageNotice(input: {
  /** Threaded to browserStageNotice; absent = asked. */
  asked?: boolean;
  active: boolean;
  hadPainted: boolean;
  parkedFrame: boolean;
  blackout: boolean;
  frameConnected: boolean;
  streamHealth: "connected" | "connecting" | "unavailable" | null;
  waitingForAuth: boolean;
  finalizing: boolean;
  onConnectionState?: ((connecting: boolean) => void) | undefined;
}): { notice: StageNotice } {
  const notice = browserStageNotice({
    asked: input.asked,
    hadFrame: input.hadPainted,
    parkedFrame: input.parkedFrame,
    blackout: input.blackout,
    frameConnected: input.frameConnected,
    streamHealth: input.streamHealth,
    waitingForAuth: input.waitingForAuth,
    finalizing: input.finalizing,
  });
  const { onConnectionState } = input;
  const reconnecting = input.active && !input.waitingForAuth && !input.finalizing
    && notice !== null && notice !== "idle" && notice !== "blackout";
  useEffect(() => {
    onConnectionState?.(reconnecting);
  }, [onConnectionState, reconnecting]);
  return { notice };
}

/** The shimmering title of a cold stage: the pane's own words for a browser opening, else the run's. */
function coldTitle(input: { idleCopy: BrowserIdleCopy | null; streamAnnounced: boolean; finalizing: boolean; resumed: boolean }): string {
  const { idleCopy, streamAnnounced, finalizing, resumed } = input;
  if (idleCopy) return streamAnnounced ? idleCopy.beforeFirstFrame : idleCopy.beforeStream;
  return connectingCopy(finalizing, resumed);
}

/**
 * The stage's overlays, rendered from the notice: the brand placeholder for a
 * pane that never painted (resting, parked, or working through a boot), or
 * the slim banner over a kept last frame.
 */
export function StageNoticeOverlays({ notice, finalizing, streamAnnounced = false, resumed = false, idleCopy = null, onRetry }: {
  notice: StageNotice;
  finalizing: boolean;
  /** A stream address is known: the wait is for its first picture, not for a sandbox. */
  streamAnnounced?: boolean;
  /** A woken run's cold stage: the same placeholder, titled as the reconnect it is. */
  resumed?: boolean;
  onRetry?: () => void;
  /** Given by a pane whose cold stage is a browser opening, not a run connecting. */
  idleCopy?: BrowserIdleCopy | null;
}) {
  if (notice === "idle") {
    return <BrowserIdlePlaceholder copy={idleCopy?.empty ?? DEFAULT_EMPTY} title={idleCopy?.title} />;
  }
  if (notice === "parked") {
    return <BrowserIdlePlaceholder title="Waiting for sign-in" copy="Take control to log in, then hand the browser back." />;
  }
  if (notice === "cold") {
    return (
      <BrowserIdlePlaceholder
        working
        title={coldTitle({ idleCopy, streamAnnounced, finalizing, resumed })}
        copy={connectingDetail(streamAnnounced, finalizing)}
      />
    );
  }
  if (notice === "reconnecting") {
    return (
      <div className="browser-stream-health" role="status">
        <span>Reconnecting the live view — the agent is still running.</span>
      </div>
    );
  }
  if (notice === "unavailable") {
    return (
      <div className="browser-stream-health" role="status">
        <span>The live browser view is unavailable.</span>
        {onRetry ? <button type="button" onClick={onRetry}>Retry connection</button> : null}
      </div>
    );
  }
  if (notice === "blackout") {
    return (
      <div className="browser-stream-health" role="status">
        <span>The live picture is paused while private information is entered.</span>
      </div>
    );
  }
  return null;
}
