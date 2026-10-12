// The browser-idle lane exits when it is genuinely unused, so the host does
// not keep a Chromium container alive for the service's whole life. "Unused"
// is no stream viewer for viewerIdleMs, measured on the CONTAINER's own
// monotonic clock.

export const VIEWER_IDLE_MS = 10 * 60_000;

/**
 * @param {object} options
 * @param {() => number} options.now Monotonic milliseconds (e.g. performance.now).
 * @param {number} [options.viewerIdleMs] Exit needs no viewer for this long.
 */
export function createIdleTracker({ now, viewerIdleMs = VIEWER_IDLE_MS }) {
  let lastViewerAt = now();
  return {
    /**
     * @param {object} sample
     * @param {number} sample.viewers Current stream viewer count.
     */
    observe({ viewers }) {
      if (viewers > 0) lastViewerAt = now();
    },
    /** True once no viewer has watched for the idle window. */
    shouldExit() {
      return now() - lastViewerAt >= viewerIdleMs;
    },
  };
}
