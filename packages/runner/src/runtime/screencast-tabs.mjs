/**
 * Which tab the live view follows.
 *
 * Every mirrored tab keeps its own flat CDP session with a thumbnail-size
 * screencast running. Chromium reports the page's visibility on that session
 * — once when the screencast starts and again whenever the tab gains or loses
 * the window's front — so the follower always knows which pages are in front
 * without asking the page (page script can lie about document.visibilityState;
 * it cannot forge a CDP event), without polling, and without re-attaching per
 * decision (each attach and detach fans out a Target.targetInfoChanged to
 * every discovery client, which a probe-per-decision design feeds on). A
 * session that is not followed never acks its frames, so Chromium stops at
 * its in-flight cap (two frames) for it.
 *
 * Selection runs on every visibility change, on the loss of the followed
 * tab, on the viewer's tab_activate and on the runtime's hint about the
 * agent's working tab, one pass at a time:
 *   1. a fresh request (viewer or agent) naming a live tab wins, once; a
 *      hidden one is brought to the front first — the agent's switch is the
 *      one signal Chromium cannot give when two pages are visible at once (a
 *      popup window beside the product tab) or when the daemon and Chromium
 *      pick different successors to a closed tab. Spent on arrival, so it
 *      never pins the view against what rises next;
 *   2. otherwise a tab that just rose to the front and is still there a
 *      moment later — a popup window opening beside the product tab, the
 *      agent switching between tabs while such a window stays visible; the
 *      moment filters a screenshot of a hidden tab, which flips it visible
 *      and back within the capture;
 *   3. otherwise a followed tab that is still visible stays (navigation
 *      blips, the echo of our own activation);
 *   4. otherwise the newest visible tab;
 *   5. otherwise nothing moves; only with no followed tab at all does the
 *      newest http page win, so a hidden, prerendered or background-opened
 *      tab is never followed by mistake.
 * A tab whose session stops answering is skipped for a while rather than
 * retried in a loop, and never holds up the next decision.
 */

// Perpetually animating pages (decorative gradients, glows) force software
// rendering to repaint at 60fps forever, starving snapshots and waits on the
// same CPU. Durations are floored to 0.01ms instead of `none` so
// animation/transition end events still fire and app flows that wait on them
// keep working; the page simply reaches its final frame instantly.
const CALM_PAGE_CSS = "*, *::before, *::after { animation-duration: 0.01ms !important;"
  + " animation-iteration-count: 1 !important; transition-duration: 0.01ms !important;"
  + " scroll-behavior: auto !important; }";
const CALM_PAGE_SCRIPT = `(() => {
  const install = () => {
    const style = document.createElement("style");
    style.setAttribute("data-shipbash-calm", "1");
    style.textContent = ${JSON.stringify(CALM_PAGE_CSS)};
    document.documentElement.appendChild(style);
  };
  if (document.documentElement) install();
  else addEventListener("DOMContentLoaded", install, { once: true });
})();`;

// The visibility-only screencast every unfollowed tab keeps running.
const THUMBNAIL_SCREENCAST = { format: "jpeg", quality: 10, maxWidth: 160, maxHeight: 90, everyNthFrame: 1 };
// How long a tab must stay visible after rising before the view moves to it.
const RISE_SETTLE_MS = 100;
// How long a tab whose session stopped answering stays out of the running.
const UNRESPONSIVE_MS = 10_000;

export function isHttpPage(target) {
  return target.type === "page" && /^https?:/u.test(target.url ?? "");
}

/**
 * A target the user would recognize as a browser tab. Blank pages stay
 * visible: a fresh OAuth popup is born as about:blank and must not flicker
 * out of the strip while it loads.
 */
export function isMirroredTab(target) {
  if (target.type !== "page") return false;
  const url = target.url ?? "";
  if (/^(?:devtools|chrome-extension|chrome-untrusted|chrome):/u.test(url)) return false;
  return url === "" || url === "about:blank" || /^https?:/u.test(url);
}

function withTimeout(promise, ms, label) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${String(ms)}ms.`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/** Attaches a fresh tab: one flat session, calm mode, the thumbnail screencast. */
async function attachTab(state, targetId) {
  const { sessions, attaching, targets, call } = state;
  if (state.closed || sessions.has(targetId) || attaching.has(targetId)) return;
  attaching.add(targetId);
  try {
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    if (state.closed || !targets.has(targetId)) {
      await call("Target.detachFromTarget", { sessionId }).catch(() => {});
      return;
    }
    sessions.set(targetId, sessionId);
    state.targetBySession.set(sessionId, targetId);
    await call("Page.enable", {}, sessionId);
    // Calm mode: ask politely via the media feature, then enforce with CSS on
    // this document and every future navigation. The evaluate is not awaited:
    // it runs in the renderer, and a renderer can be busy or blocked.
    await call("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    }, sessionId).catch(() => {});
    await call("Page.addScriptToEvaluateOnNewDocument", { source: CALM_PAGE_SCRIPT }, sessionId).catch(() => {});
    void call("Runtime.evaluate", { expression: CALM_PAGE_SCRIPT }, sessionId).catch(() => {});
    // Lane-scoped page scripts (browser-idle passes the passkey one): declared
    // for every future navigation and run once on the current document, the
    // same way calm mode is, so a page already loaded is covered too.
    for (const source of state.initScripts) {
      await call("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId).catch(() => {});
      void call("Runtime.evaluate", { expression: source }, sessionId).catch(() => {});
    }
    // Chromium answers this with the page's current visibility on this
    // session; every later front change arrives the same way.
    await call("Page.startScreencast", THUMBNAIL_SCREENCAST, sessionId);
  } catch {
    const sessionId = sessions.get(targetId);
    if (sessionId) {
      sessions.delete(targetId);
      state.targetBySession.delete(sessionId);
      void call("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  } finally {
    attaching.delete(targetId);
  }
  state.reselect();
}

function forgetSession(state, targetId) {
  const sessionId = state.sessions.get(targetId);
  if (sessionId) state.targetBySession.delete(sessionId);
  state.sessions.delete(targetId);
  state.visibility.delete(targetId);
  state.risenAt.delete(targetId);
}

function dropFollow(state, targetId) {
  if (targetId !== state.followedId) return;
  state.followedId = null;
  state.onUnfollow();
}

function responsive(state, targetId) {
  const at = state.unresponsiveAt.get(targetId);
  if (at === undefined) return true;
  if (Date.now() - at < UNRESPONSIVE_MS) return false;
  state.unresponsiveAt.delete(targetId);
  return true;
}

function requestedTab(state) {
  const { request, targets } = state;
  if (request === null || Date.now() - request.at > state.requestTtlMs) return null;
  if (request.targetId) return targets.has(request.targetId) ? request.targetId : null;
  const match = [...targets.values()].filter((target) => isMirroredTab(target) && target.url === request.url);
  // Twins at one url: the daemon's switch is a bringToFront, so the agent's
  // tab is the visible one; failing that, the one already on screen.
  const preferred = match.find((target) => state.visibility.get(target.targetId) === true)
    ?? match.find((target) => target.targetId === state.followedId);
  return (preferred ?? match.at(-1))?.targetId ?? null;
}

// The newest tab that rose to the front long enough ago to be believed; a
// younger one books a fresh decision for when it has settled.
function risenTab(state) {
  let settled = null;
  let soonest = Infinity;
  for (const [targetId, at] of state.risenAt) {
    if (state.visibility.get(targetId) !== true || !responsive(state, targetId)) continue;
    const age = Date.now() - at;
    if (age >= RISE_SETTLE_MS) settled = targetId;
    else soonest = Math.min(soonest, RISE_SETTLE_MS - age);
  }
  if (soonest !== Infinity) setTimeout(state.reselect, soonest + 1).unref?.();
  return settled;
}

function chooseTab(state) {
  const { followedId, targets, visibility } = state;
  const wanted = requestedTab(state);
  if (wanted && responsive(state, wanted)) return { targetId: wanted, front: true };
  const rising = risenTab(state);
  if (rising) return { targetId: rising };
  const followedLive = followedId !== null && targets.has(followedId);
  if (followedLive && visibility.get(followedId) !== false) return { targetId: followedId };
  const mirrored = [...targets.values()].filter((target) => isMirroredTab(target) && responsive(state, target.targetId));
  const visible = mirrored.filter((target) => visibility.get(target.targetId) === true);
  if (visible.length) return { targetId: visible.at(-1).targetId };
  if (followedLive) return { targetId: followedId };
  // Tabs still attaching have not reported yet; wait rather than start on a
  // hidden one and switch again a moment later.
  if (state.attaching.size > 0) return null;
  const http = mirrored.filter(isHttpPage);
  return http.length ? { targetId: http.at(-1).targetId } : null;
}

async function bringToFront(state, targetId) {
  if (state.visibility.get(targetId) === true) return;
  await state.call("Target.activateTarget", { targetId }).catch(() => {});
  const sessionId = state.sessions.get(targetId);
  if (sessionId) await state.call("Page.bringToFront", {}, sessionId).catch(() => {});
}

async function switchTo(state, targetId) {
  const { sessions, call } = state;
  const sessionId = sessions.get(targetId);
  // Not attached yet: the attach that is under way reselects when it lands.
  if (!sessionId || state.attaching.has(targetId)) return;
  const previous = state.followedId ? sessions.get(state.followedId) ?? null : null;
  state.followedId = targetId;
  state.risenAt.delete(targetId);
  state.onUnfollow();
  // Not awaited: a previous tab whose renderer hung must not delay the move.
  if (previous) {
    void call("Page.stopScreencast", {}, previous)
      .then(() => call("Page.startScreencast", THUMBNAIL_SCREENCAST, previous))
      .then(() => call("Runtime.disable", {}, previous))
      .catch(() => {});
  }
  // The first command on the new session doubles as its liveness probe; a
  // session that does not answer is skipped for a while (see selectOnce).
  // Nothing follows on it after this: its unacked thumbnail frames already
  // arrived, and Chromium sends no more until the full-size start.
  await call("Page.stopScreencast", {}, sessionId);
  const target = state.targets.get(targetId);
  await state.onFollow(target, sessionId);
  await call("Page.startScreencast", state.screencast, sessionId);
  state.onStreaming(target);
}

async function selectOnce(state) {
  const choice = chooseTab(state);
  if (!choice) return;
  if (choice.front) {
    await bringToFront(state, choice.targetId);
    // Spent once the tab can be followed; kept only while its attach lands.
    if (state.sessions.has(choice.targetId)) state.request = null;
  }
  if (choice.targetId === state.followedId) return;
  try {
    await switchTo(state, choice.targetId);
  } catch {
    // The tab went away or its renderer never answered: it sits out, and
    // the pass runs once more so another tab can take the screen.
    if (state.followedId === choice.targetId) {
      state.followedId = null;
      state.unresponsiveAt.set(choice.targetId, Date.now());
      state.dirty = true;
    }
  }
}

/** One decision at a time; a trigger during a pass runs one more pass after it. */
function reselect(state) {
  if (state.closed) return;
  state.dirty = true;
  if (state.running) return;
  state.running = (async () => {
    while (state.dirty && !state.closed) {
      state.dirty = false;
      await selectOnce(state);
    }
  })().finally(() => {
    state.running = null;
  });
}

/**
 * @param {{
 *   send: (method: string, params?: object, sessionId?: string) => Promise<any>,
 *   screencast: { format: string, quality: number, maxWidth: number, maxHeight: number, everyNthFrame: number },
 *   onUnfollow: () => void,
 *   onFollow: (target: object, sessionId: string) => Promise<void>,
 *   onStreaming: (target: object) => void,
 *   commandTimeoutMs?: number,
 *   requestTtlMs?: number,
 * }} options
 */
export function createTabFollower({
  send,
  screencast,
  onUnfollow,
  onFollow,
  onStreaming,
  /** Page scripts injected on every mirrored tab, before any page script. */
  initScripts = /** @type {string[]} */ ([]),
  // Renderer-side commands can hang behind a dialog, a paused new target or
  // a discarded renderer; a hung follow must not wedge every later one.
  commandTimeoutMs = 2_000,
  requestTtlMs = 3_000,
}) {
  const state = {
    call: (method, params = {}, sessionId) => withTimeout(send(method, params, sessionId), commandTimeoutMs, method),
    screencast,
    onUnfollow,
    onFollow,
    onStreaming,
    initScripts,
    requestTtlMs,
    targets: new Map(), // targetId → targetInfo (insertion order = tab order)
    sessions: new Map(), // targetId → sessionId
    targetBySession: new Map(),
    attaching: new Set(),
    visibility: new Map(), // targetId → boolean, from CDP events only
    risenAt: new Map(), // targetId → when it last became visible
    unresponsiveAt: new Map(), // targetId → when its session last hung
    followedId: null,
    request: null, // { targetId?: string, url?: string, at: number }
    closed: false,
    running: null,
    dirty: false,
    reselect: () => {},
  };
  state.reselect = () => reselect(state);
  const mirrored = () => [...state.targets.values()].filter(isMirroredTab);

  return {
    /** A target appeared or changed: keep the registry, attach a fresh tab. */
    upsert(targetInfo) {
      state.targets.set(targetInfo.targetId, targetInfo);
      if (isMirroredTab(targetInfo)) void attachTab(state, targetInfo.targetId);
    },
    /** A target is gone; the follow moves on if it was the one on screen. */
    remove(targetId) {
      forgetSession(state, targetId);
      state.unresponsiveAt.delete(targetId);
      state.targets.delete(targetId);
      dropFollow(state, targetId);
      state.reselect();
    },
    /** Chromium's word on a page's visibility, on that page's own session. */
    visibilityChanged(sessionId, visible) {
      const targetId = state.targetBySession.get(sessionId);
      if (!targetId) return;
      const now = visible === true;
      if (now && state.visibility.get(targetId) !== true && targetId !== state.followedId) state.risenAt.set(targetId, Date.now());
      if (!now) state.risenAt.delete(targetId);
      state.visibility.set(targetId, now);
      state.reselect();
    },
    /** The session died under us (target destroyed, renderer gone). */
    sessionDetached(sessionId) {
      const targetId = state.targetBySession.get(sessionId);
      if (!targetId) return;
      forgetSession(state, targetId);
      dropFollow(state, targetId);
      if (state.targets.has(targetId)) void attachTab(state, targetId);
      state.reselect();
    },
    /** The viewer picked a tab in the strip. */
    requestTab(targetId) {
      const target = state.targets.get(targetId);
      if (!target || !isMirroredTab(target)) return;
      state.request = { targetId, at: Date.now() };
      state.reselect();
    },
    /** The runtime says the agent is working in the tab at this URL. */
    requestUrl(url) {
      if (typeof url !== "string" || !url) return;
      state.request = { url, at: Date.now() };
      state.reselect();
    },
    tabs: mirrored,
    target: (targetId) => state.targets.get(targetId) ?? null,
    /** Restart only the followed screencast to elicit a frame on a static page. */
    async requestFreshFrame() {
      if (state.closed) return false;
      if (state.running) return true;
      const targetId = state.followedId;
      const sessionId = targetId ? state.sessions.get(targetId) : null;
      if (!sessionId) return false;
      try {
        await state.call("Page.stopScreencast", {}, sessionId);
        if (state.closed || state.followedId !== targetId || state.sessions.get(targetId) !== sessionId) return false;
        await state.call("Page.startScreencast", state.screencast, sessionId);
        return !state.closed && state.followedId === targetId;
      } catch {
        return false;
      }
    },
    close() {
      state.closed = true;
    },
  };
}
