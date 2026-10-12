/**
 * What one viewer receives from the gateway: every small event message as it
 * comes, and screencast frames paced to the viewer's own budget. The viewer
 * names a frame-rate cap on its connection URL; the socket's backlog is the
 * backstop when it cannot keep up even with that.
 */
import WebSocket from "ws";

// A viewer whose socket already buffers this much is not keeping up. Bulky
// messages (screencast frames, which the next frame supersedes anyway) are
// dropped for that viewer; small event messages still pass, so the pointer
// and browser telemetry stay live while the picture degrades to fewer frames.
export const FRAME_DROP_BUFFERED_BYTES = 1024 * 1024;
export const FRAME_DROP_MIN_MESSAGE_BYTES = 4096;

function messageByteLength(data) {
  return typeof data === "string" ? Buffer.byteLength(data) : data.length ?? 0;
}

/**
 * The viewer's frame-rate cap from its connection URL: `?maxFps=N` with N in
 * 1–60. Absent means unlimited (null); any other query is invalid (undefined).
 */
export function viewerMaxFps(searchParams) {
  if (searchParams.size === 0) return null;
  const raw = searchParams.get("maxFps");
  if (searchParams.size !== 1 || raw === null) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= 60 ? value : undefined;
}

/**
 * What one viewer is sent of the upstream stream. Small event messages (the
 * pointer, browser telemetry, status) always pass at once. Bulky messages —
 * screencast frames, which the next frame supersedes anyway — are paced to
 * the viewer's `maxFps`, latest-wins: the newest frame is what goes out when
 * the interval elapses. As the backstop, a frame is dropped outright while
 * the viewer's socket still buffers more than `frameDropBufferedBytes`, so a
 * stalled viewer degrades to fewer frames instead of falling further behind.
 */
export function createViewerOutbound(client, { maxFps, frameDropBufferedBytes, frameDropMinMessageBytes }) {
  const frameIntervalMs = maxFps === null ? 0 : 1_000 / maxFps;
  let pending = null;
  let timer = null;
  let lastFrameAt = 0;

  const sendFrame = (data, isBinary) => {
    if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > frameDropBufferedBytes) return;
    lastFrameAt = Date.now();
    client.send(data, { binary: isBinary });
  };
  const flush = () => {
    timer = null;
    if (pending === null) return;
    const { data, isBinary } = pending;
    pending = null;
    sendFrame(data, isBinary);
  };
  return {
    send(data, isBinary) {
      if (messageByteLength(data) <= frameDropMinMessageBytes) {
        client.send(data, { binary: isBinary });
        return;
      }
      if (frameIntervalMs === 0) {
        sendFrame(data, isBinary);
        return;
      }
      pending = { data, isBinary };
      if (timer !== null) return;
      const wait = frameIntervalMs - (Date.now() - lastFrameAt);
      if (wait <= 0) {
        flush();
        return;
      }
      timer = setTimeout(flush, wait);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
