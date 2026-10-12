/**
 * The screencast sidecar's source: one CDP connection to the browser, and
 * everything bound to it — the command channel, the tab follower and its
 * page sessions, the navigation and favicon mirrors, the message router, and
 * the probe that gives up on a connection that stopped answering. Split from
 * screencast-sidecar.mjs by lifetime: the sidecar owns its viewers, their
 * control seat, the broadcasts they are seeded from and the generation every
 * discontinuity starts; the source owns what dies with its socket, and tells
 * the sidecar when the picture is discontinued. When a source is lost the
 * sidecar opens another on the same browser.
 */
import WebSocket from "ws";

import { createCdpMessageRouter } from "./screencast-cdp-router.mjs";
import { createNavStateMirror } from "./screencast-nav.mjs";
import { createFaviconResolver } from "./screencast-favicon.mjs";
import { createTabFollower } from "./screencast-tabs.mjs";

const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 2_000;
// A browser that accepts the connection but never answers the upgrade (a
// frozen process) must not hold an attach forever.
const HANDSHAKE_TIMEOUT_MS = 5_000;

/**
 * Why a failed connection proves the browser behind `cdpUrl` is gone, or null
 * when it does not. No process listens on its port any more ("refused"), or a
 * Chromium there does not know its browser id ("unknown_browser": Chromium
 * answers an unknown /devtools/browser/<id> with 404). Anything else — a
 * timeout, a hung handshake — may still be the same browser.
 */
export function browserGoneCause(error) {
  if (error?.code === "ECONNREFUSED") return "refused";
  return error?.statusCode === 404 ? "unknown_browser" : null;
}

/** The CDP command channel: renderer-side commands can hang (dialog, paused target, dead renderer). */
function createCommandChannel(cdp) {
  let commandId = 0;
  const pendingCommands = new Map();
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    commandId += 1;
    const id = commandId;
    const timer = setTimeout(() => {
      if (pendingCommands.delete(id)) reject(new Error(`${method} timed out.`));
    }, COMMAND_TIMEOUT_MS);
    timer.unref?.();
    pendingCommands.set(id, { resolve, reject, timer });
    cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { send, pendingCommands };
}

/**
 * Constructs the tab follower, navigation and favicon wiring around the
 * sidecar's control plane. Everything this connection tells the sidecar goes
 * through `broadcast`, `announce` and `discontinue`, which fall silent once
 * the connection is closed: a follow still in flight when the source is lost
 * or replaced must not restate the sidecar's status or touch the next page.
 */
function createSourceWiring({ send, broadcast: sidecarBroadcast, control, announce: sidecarAnnounce, discontinue: sidecarDiscontinue, generation, quality, maxWidth, maxHeight, initScripts }) {
  // The follower updates this record; the router stamps every frame with the
  // sidecar's current generation.
  const state = {
    attachedTargetId: null,
    attachedSessionId: null,
    get generation() {
      return generation();
    },
    framesDelivered: 0,
    probeTimer: null,
    // Why this connection is being given up on, when the source itself ends it.
    lostCause: "socket_closed",
    // When the browser last answered on this connection: its attach, then each probe it answered.
    answeredAt: null,
    closed: false,
  };
  const whileOpen = (tell) => (...args) => (state.closed ? undefined : tell(...args));
  const broadcast = whileOpen(sidecarBroadcast);
  const announce = whileOpen(sidecarAnnounce);
  const discontinue = whileOpen(sidecarDiscontinue);
  const favicons = createFaviconResolver({
    send,
    attachedTarget: () => state.attachedTargetId,
    attachedSession: () => state.attachedSessionId,
    onResolved: () => publishTabs(),
  });
  const publishTabs = () => {
    const tabs = follower.tabs().map((target) => ({
      tabId: target.targetId,
      title: target.title ?? "",
      url: target.url ?? "",
      active: target.targetId === state.attachedTargetId,
      faviconDataUrl: favicons.dataUrlFor(target.targetId),
    }));
    if (!tabs.length) return;
    broadcast({ type: "tabs", tabs, timestamp: Date.now() });
    const current = follower.target(state.attachedTargetId);
    if (current) broadcast({ type: "url", url: current.url, timestamp: Date.now() });
  };

  // Broadcast retains the last nav_state, so joining viewers are seeded like url/tabs.
  const nav = createNavStateMirror({
    send,
    broadcast,
    attachedSession: () => state.attachedSessionId,
    onMainFrameNavigated: () => {
      void favicons.refresh();
    },
  });

  // Wait for the first followed page, with a 3s fallback for an empty browser.
  let firstFollow = () => {};
  const followed = new Promise((resolve) => { firstFollow = resolve; });
  const follower = createTabFollower({
    send,
    initScripts,
    screencast: { format: "jpeg", quality, maxWidth, maxHeight, everyNthFrame: 1 },
    // The follow moves on (another tab, or the followed one is gone).
    onUnfollow: () => {
      state.attachedSessionId = null;
      discontinue();
    },
    onFollow: async (target, sessionId) => {
      control.pageWillAttach();
      state.attachedTargetId = target.targetId;
      state.attachedSessionId = sessionId;
      await send("Runtime.enable", {}, sessionId).catch(() => {});
      await nav.pageAttached(sessionId);
      const viewport = (await send("Page.getLayoutMetrics", {}, sessionId).catch(() => null))?.cssLayoutViewport ?? {};
      if (state.closed) return;
      announce({
        viewportWidth: Number(viewport.clientWidth) || maxWidth,
        viewportHeight: Number(viewport.clientHeight) || maxHeight,
      });
      publishTabs();
      await control.pageAttached();
    },
    onStreaming: () => {
      firstFollow();
      void favicons.refresh();
    },
  });
  return { state, favicons, publishTabs, nav, followed, follower, broadcast, discontinue };
}

/**
 * The CDP socket's own death. A closed observer socket proves transport loss,
 * not Chrome death: the sidecar learns which by attaching again. The status
 * it starts says since when the browser has not been heard from (its last
 * answer on this connection), so whoever counts its silence counts from there.
 */
function attachCdpLifecycle({ cdp, state, discontinue, onLost }) {
  cdp.on("close", () => {
    if (state.closed) return;
    clearInterval(state.probeTimer);
    discontinue({ connected: false, screencasting: false, silentSince: state.answeredAt });
    onLost({ cause: state.lostCause });
  });
}

/** A healthy static page still answers this cheap command on the same CDP socket. */
function startSourceProbe({ state, cdp, send }) {
  let failures = 0;
  let inFlight = false;
  const timer = setInterval(async () => {
    if (state.closed || inFlight || cdp.readyState !== WebSocket.OPEN) return;
    inFlight = true;
    try {
      await send("Browser.getVersion");
      failures = 0;
      state.answeredAt = Date.now();
    } catch {
      failures += 1;
      if (failures < 2) return;
      state.lostCause = "unresponsive";
      cdp.terminate();
    } finally {
      inFlight = false;
    }
  }, 5_000);
  timer.unref?.();
  state.probeTimer = timer;
}

/**
 * Complete the original CDP attach without looking up or launching another
 * browser. A refused upgrade rejects with its HTTP status.
 */
async function initializeCdp(cdp, send, follower, downloadDirectory) {
  await new Promise((resolve, reject) => {
    cdp.once("open", resolve);
    cdp.once("error", reject);
    cdp.once("unexpected-response", (_request, response) => {
      reject(Object.assign(new Error(`The browser endpoint answered ${String(response.statusCode)}.`), { statusCode: response.statusCode }));
      cdp.terminate();
    });
  });
  const { targetInfos } = await send("Target.getTargets", {});
  for (const target of targetInfos) follower.upsert(target);
  await send("Target.setDiscoverTargets", { discover: true });
  if (downloadDirectory) {
    await send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: downloadDirectory,
      eventsEnabled: true,
    }).catch(() => {});
  }
}

/**
 * Opens the source on `cdpUrl` and resolves once it is attached; a connection
 * that fails is closed and rejects. The source is handed to `adopt` the
 * moment its socket exists, before any command goes out, so the page hooks
 * of its first follow (the control plane's) already reach this connection.
 * `control` is the sidecar's control plane: the source tells it when a page
 * attaches and what that page's dialogs do. `announce` restates the sidecar's
 * status, `discontinue` starts its next generation, and `generation` reads
 * the one every frame is stamped with. `onLost` hears once when the attached
 * connection is lost. `followed` settles on the first followed page, or after
 * 3 s on an empty browser.
 */
export async function openScreencastSource({
  cdpUrl, broadcast: sidecarBroadcast, control, announce: sidecarAnnounce, discontinue: sidecarDiscontinue, generation,
  quality, maxWidth, maxHeight, frameIntervalMs, initScripts, downloadDirectory, adopt, onLost,
}) {
  const cdp = new WebSocket(cdpUrl, { perMessageDeflate: false, maxPayload: MAX_PAYLOAD_BYTES, handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
  // A socket error is always followed by its close; the open waits on the error itself.
  cdp.on("error", () => {});
  const { send, pendingCommands } = createCommandChannel(cdp);
  const { state, favicons, publishTabs, nav, followed, follower, broadcast, discontinue } = createSourceWiring({
    send, broadcast: sidecarBroadcast, control, announce: sidecarAnnounce, discontinue: sidecarDiscontinue,
    generation, quality, maxWidth, maxHeight, initScripts,
  });
  cdp.on("message", createCdpMessageRouter({
    state,
    pendingCommands,
    send,
    broadcast,
    follower,
    favicons,
    nav,
    control,
    publishTabs,
    maxWidth,
    maxHeight,
    frameIntervalMs,
  }));

  const close = () => {
    state.closed = true;
    clearInterval(state.probeTimer);
    follower.close();
    for (const { reject, timer } of pendingCommands.values()) {
      clearTimeout(timer);
      reject(new Error("Screencast sidecar closed."));
    }
    pendingCommands.clear();
    cdp.terminate();
  };
  const source = {
    send,
    attachedSession: () => state.attachedSessionId,
    requestTab: (tabId) => follower.requestTab(tabId),
    /** The agent's working tab by url (the daemon's tab list after a tab tool). */
    followAgentTab: (url) => follower.requestUrl(url),
    /** Restart the followed screencast to elicit a frame on a static page. */
    requestFreshFrame: async () => cdp.readyState === WebSocket.OPEN && await follower.requestFreshFrame(),
    close,
    followed: Promise.race([followed, new Promise((resolve) => { setTimeout(resolve, 3_000).unref?.(); })]),
  };
  adopt(source);
  try {
    await initializeCdp(cdp, send, follower, downloadDirectory);
  } catch (error) {
    close();
    throw error;
  }
  // Attached (again): the picture that follows is this connection's, and the browser has just answered.
  state.answeredAt = Date.now();
  discontinue({ connected: true, screencasting: true, silentSince: null });
  attachCdpLifecycle({ cdp, state, discontinue, onLost });
  startSourceProbe({ state, cdp, send });
  return source;
}
