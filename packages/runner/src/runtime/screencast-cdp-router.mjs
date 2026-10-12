/**
 * Everything the sidecar does with an inbound CDP message, split from
 * screencast-sidecar.mjs by direction: the sidecar owns the sockets, the
 * lifecycle and the public handle, this owns what one message means.
 *
 * Four kinds arrive: an answer to a command the sidecar sent, a frame from
 * the page currently on screen, a target-lifecycle event the tab follower
 * consumes, and a page event that only counts when it came from the attached
 * page. Method names are distinct constants and the nav mirror claims only
 * `Page.frame*`, so no message can match two of these.
 *
 * Attach state (which target, which session, which generation, how many
 * frames, whether the sidecar is closing) lives in the `state` record the
 * sidecar shares, because the follower writes it and this reads it on every
 * frame.
 */
import { screencastBlackedOut } from "./screencast-blackout.mjs";

function settleCommand(pendingCommands, message) {
  const { resolve, reject, timer } = pendingCommands.get(message.id);
  clearTimeout(timer);
  pendingCommands.delete(message.id);
  if (message.error) reject(new Error(message.error.message ?? "CDP command failed."));
  else resolve(message.result);
}

/**
 * One frame out to every viewer, then a paced ack: Chromium withholds the
 * next frame until the previous one is acked, so a delayed ack caps the frame
 * rate at the source instead of encoding 60fps nobody needs.
 */
function deliverFrame(deps, params, sessionId) {
  const { state, broadcast, maxWidth, maxHeight } = deps;
  const metadata = params.metadata ?? {};
  state.framesDelivered += 1;
  // While a credential is being typed the picture is withheld from every
  // viewer at once, and the ack below still goes out so the stream resumes
  // the moment the blackout lifts.
  if (screencastBlackedOut()) {
    scheduleAck(deps, params, sessionId);
    return;
  }
  const target = deps.follower.target(state.attachedTargetId);
  broadcast({
    type: "frame",
    data: params.data,
    tabId: state.attachedTargetId,
    generation: state.generation,
    sequence: state.framesDelivered,
    url: target?.url || "about:blank",
    title: target?.title ?? "",
    metadata: {
      offsetTop: metadata.offsetTop ?? 0,
      pageScaleFactor: metadata.pageScaleFactor ?? 1,
      deviceWidth: metadata.deviceWidth ?? maxWidth,
      deviceHeight: metadata.deviceHeight ?? maxHeight,
      scrollOffsetX: metadata.scrollOffsetX ?? 0,
      scrollOffsetY: metadata.scrollOffsetY ?? 0,
      // CDP stamps the frame in float seconds since the epoch; viewers and
      // the recorder measure frame age against Date.now(), so it goes out
      // as integer epoch milliseconds.
      timestamp: Math.round((metadata.timestamp ?? 0) * 1_000),
    },
  });
  scheduleAck(deps, params, sessionId);
}

/** The paced acknowledgement that lets Chromium send the next frame. */
function scheduleAck(deps, params, sessionId) {
  const { state, send, frameIntervalMs } = deps;
  setTimeout(() => {
    if (state.closed) return;
    void send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId)
      .catch(() => {});
  }, frameIntervalMs).unref?.();
}

/** The target list and per-page visibility the follower mirrors. */
function routeTargetEvent(deps, method, params, sessionId) {
  const { follower, favicons, publishTabs } = deps;
  if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
    follower.upsert(params.targetInfo);
    publishTabs();
    return true;
  }
  if (method === "Target.targetDestroyed") {
    follower.remove(params.targetId);
    favicons.forget(params.targetId);
    publishTabs();
    return true;
  }
  if (method === "Target.detachedFromTarget") {
    follower.sessionDetached(params.sessionId);
    return true;
  }
  if (method === "Page.screencastVisibilityChanged") {
    follower.visibilityChanged(sessionId, params.visible);
    return true;
  }
  return false;
}

/** Events that only count from the page on screen: history, dialogs, console. */
function routeAttachedPageEvent(deps, method, params) {
  const { nav, control, broadcast } = deps;
  if (nav.handles(method)) {
    nav.pageLifecycleEvent(method, params);
    return;
  }
  if (method === "Page.javascriptDialogOpening") {
    control.dialogOpening(params);
    return;
  }
  if (method === "Page.javascriptDialogClosed") {
    control.dialogClosed();
    return;
  }
  if (method === "Page.fileChooserOpened") {
    control.fileChooserOpened(params);
    return;
  }
  if (method !== "Runtime.consoleAPICalled") return;
  const text = (params.args ?? [])
    .map((argument) => (argument.value !== undefined ? String(argument.value) : argument.description ?? ""))
    .join(" ")
    .trim();
  if (text) {
    broadcast({ type: "console", level: params.type ?? "log", text: text.slice(0, 2_000), timestamp: Date.now() });
  }
}

export function createCdpMessageRouter(deps) {
  const { state, pendingCommands, broadcast } = deps;
  return (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.id !== undefined && pendingCommands.has(message.id)) {
      settleCommand(pendingCommands, message);
      return;
    }
    const { method, params, sessionId } = message;
    if (method === "Page.screencastFrame" && sessionId === state.attachedSessionId) {
      deliverFrame(deps, params, sessionId);
      return;
    }
    if (routeTargetEvent(deps, method, params, sessionId)) return;
    if (method === "Browser.downloadWillBegin") {
      // A download belongs to the browser, not to one page: no session gate.
      broadcast({
        type: "download",
        state: "started",
        suggestedFilename: String(params.suggestedFilename ?? "").slice(0, 200),
        timestamp: Date.now(),
      });
      return;
    }
    if (sessionId !== state.attachedSessionId) return;
    routeAttachedPageEvent(deps, method, params);
  };
}
