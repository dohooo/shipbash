/**
 * The sidecar's navigation-state mirror: everything viewers learn about the
 * attached page's history and loading, published as
 * `{type:"nav_state", canGoBack, canGoForward, loading}`.
 *
 * The state is recomputed from CDP's real navigation history — never guessed
 * from URLs — on main-frame lifecycle events, restated on every (re)attach,
 * and (via the sidecar's broadcast cache) replayed to joining clients like
 * url/tabs. Loading tracks the main frame only, so an iframe cannot flicker
 * the chrome's progress line.
 */

// Main-frame lifecycle events the mirror consumes.
const PAGE_LIFECYCLE_EVENTS = new Set([
  "Page.frameNavigated",
  "Page.frameStartedLoading",
  "Page.frameStoppedLoading",
]);

export function createNavStateMirror({ send, broadcast, attachedSession, onMainFrameNavigated }) {
  let mainFrameId = null;
  let navState = { canGoBack: false, canGoForward: false, loading: false };

  const publish = (partial) => {
    navState = { ...navState, ...partial };
    broadcast({ type: "nav_state", ...navState, timestamp: Date.now() });
  };
  const refreshHistory = async () => {
    const sessionId = attachedSession();
    if (!sessionId) return;
    const history = await send("Page.getNavigationHistory", {}, sessionId).catch(() => null);
    if (!history || sessionId !== attachedSession()) return;
    const entries = Array.isArray(history.entries) ? history.entries : [];
    const index = typeof history.currentIndex === "number" ? history.currentIndex : -1;
    publish({
      canGoBack: index > 0,
      canGoForward: index >= 0 && index < entries.length - 1,
    });
  };

  return {
    handles: (method) => PAGE_LIFECYCLE_EVENTS.has(method),
    /** Fresh attach: learn the main frame, restate defaults, fill in history. */
    async pageAttached(sessionId) {
      const frameTree = await send("Page.getFrameTree", {}, sessionId).catch(() => null);
      mainFrameId = frameTree?.frameTree?.frame?.id ?? null;
      publish({ canGoBack: false, canGoForward: false, loading: false });
      void refreshHistory();
    },
    /** Main-frame navigations and load starts/stops on the attached page. */
    pageLifecycleEvent(method, params) {
      if (method === "Page.frameNavigated") {
        if (params.frame?.parentId) return;
        mainFrameId = params.frame?.id ?? mainFrameId;
        onMainFrameNavigated();
        void refreshHistory();
        return;
      }
      if (mainFrameId !== null && params.frameId !== mainFrameId) return;
      publish({ loading: method === "Page.frameStartedLoading" });
      // A finished load can add a history entry (or drop forward entries).
      if (method === "Page.frameStoppedLoading") void refreshHistory();
    },
  };
}
