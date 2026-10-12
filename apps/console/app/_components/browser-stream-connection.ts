import { isRecord } from "../../lib/is-record";
import { propertyOf } from "../../lib/property-of";
import { browserSourceKey, newerFrame, paintedBrowserFrame, type PaintedBrowserFrame } from "./browser-presentation";

/** One JSON object off the live stream socket, read one field at a time. */
export type BrowserStreamMessage = Record<string, unknown>;

interface BrowserStreamTarget {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  frame: HTMLDivElement;
}

interface BrowserStreamHandlers {
  canReconnect: () => boolean;
  onClose: () => void;
  onConnecting: () => void;
  onError: () => void;
  onFrameSize: (size: { width: number; height: number }) => void;
  onFramePainted: (frame: PaintedBrowserFrame, replayed: boolean) => void;
  onMessage: (message: BrowserStreamMessage) => void;
  onOpen: () => void;
}

interface BrowserStreamOptions {
  clearBeforeConnect: boolean;
  handlers: BrowserStreamHandlers;
  reconnectDelayMs: number | null;
  /** The caller's live-socket slot, kept in step so `send` reaches this socket. */
  socketSlot: { current: WebSocket | null };
  streamUrl: string;
  target: BrowserStreamTarget;
}

/** A stream that has been prepared but not yet opened. */
interface BrowserStreamConnection {
  connect: () => void;
  stop: () => void;
}

// Shared throttle state for the frame-arrival diagnostic log.
const frameLogState = { count: 0, lastLogAt: 0 };

function browserStreamMessage(value: unknown): BrowserStreamMessage | null {
  return isRecord(value) ? value : null;
}

function logFrameArrival(): void {
  frameLogState.count += 1;
  const nowMs = Date.now();
  if (nowMs - frameLogState.lastLogAt > 1_000) {
    // Timing diagnostics: correlate frame arrivals against
    // [agent-pointer] ages to localize cursor-vs-effect lag.
    console.debug("[frame]", `n=${String(frameLogState.count)}`, `t=${String(nowMs % 100000)}`);
    frameLogState.lastLogAt = nowMs;
  }
}

interface SourceHealth {
  sourceKey: string | null;
  revision: number;
  disconnected: boolean;
  sourceDisconnected: boolean;
  blackedOut: boolean;
  latestFrame: PaintedBrowserFrame | null;
}

function updateSourceHealth(message: BrowserStreamMessage, health: SourceHealth): void {
  if (message.type === "status") {
    const sourceKey = browserSourceKey(message);
    if (sourceKey && sourceKey !== health.sourceKey) {
      health.sourceKey = sourceKey;
      health.latestFrame = null;
      health.revision += 1;
    }
    if (message.connected === false) { health.sourceDisconnected = true; health.revision += 1; }
    if (message.connected === true) health.sourceDisconnected = false;
    if (message.blackout === true || message.screencasting === false) {
      health.blackedOut = true;
      health.revision += 1;
    } else if (message.blackout === false || message.screencasting === true) health.blackedOut = false;
  }
  if (message.type === "gateway_status") {
    health.disconnected = message.upstream !== "connected";
    if (health.disconnected) health.revision += 1;
  }
}

/**
 * Paints one decoded frame. Frames are downscaled to fit the stream cap, so
 * canvas pixels are NOT page pixels. Every frame carries the page's own CSS
 * size; takeover input reads these to translate a click back into page
 * coordinates. Without them a 1920-wide page behind 1280-wide frames put every
 * click at two thirds of where the user aimed.
 */
function drawFrame(
  target: BrowserStreamTarget,
  image: HTMLImageElement,
  metadata: unknown,
): { width: number; height: number } {
  const width = image.naturalWidth || 1280;
  const height = image.naturalHeight || 720;
  target.canvas.width = width;
  target.canvas.height = height;
  const pageWidth = Number(propertyOf(metadata, "deviceWidth"));
  const pageHeight = Number(propertyOf(metadata, "deviceHeight"));
  target.canvas.dataset.pageWidth = String(Number.isFinite(pageWidth) && pageWidth > 0 ? pageWidth : width);
  target.canvas.dataset.pageHeight = String(Number.isFinite(pageHeight) && pageHeight > 0 ? pageHeight : height);
  target.frame.style.setProperty("--browser-aspect", `${target.canvas.width} / ${target.canvas.height}`);
  target.context.drawImage(image, 0, 0, target.canvas.width, target.canvas.height);
  return { width, height };
}

/**
 * The live browser stream: one socket at a time, reconnecting on the caller's
 * policy, painting frames onto the caller's canvas and handing every other
 * message up. Prepared and opened in two steps so the caller can publish the
 * stop handle before the first connection attempt announces itself.
 */
export function createBrowserStreamConnection(options: BrowserStreamOptions): BrowserStreamConnection {
  const { clearBeforeConnect, handlers, reconnectDelayMs, socketSlot, streamUrl, target } = options;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let stopped = false;
  // The canvas starts at the default 1280x720 attributes, so a first frame
  // of the same size would never look like a change — track notifications
  // explicitly instead of comparing against the canvas.
  let notifiedFrameSize = "";
  const health: SourceHealth = {
    sourceKey: null, revision: 0, disconnected: false,
    sourceDisconnected: false, blackedOut: false, latestFrame: null,
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const activeSocket = socket;
    socket = null;
    activeSocket?.close();
  };

  const receiveFrame = (nextSocket: WebSocket, message: BrowserStreamMessage, data: string) => {
    logFrameArrival();
    const frame = paintedBrowserFrame(message);
    if (!frame || frame.sourceKey !== health.sourceKey
      || health.disconnected || health.sourceDisconnected || health.blackedOut) return;
    if (!newerFrame(frame, health.latestFrame)) return;
    health.latestFrame = frame;
    const revision = health.revision;
    const image = new Image();
    image.onload = () => {
      if (stopped || socket !== nextSocket || revision !== health.revision || health.latestFrame !== frame) return;
      const size = drawFrame(target, image, message.metadata);
      const frameSize = `${String(size.width)}x${String(size.height)}`;
      if (notifiedFrameSize !== frameSize) {
        notifiedFrameSize = frameSize;
        handlers.onFrameSize(size);
      }
      handlers.onFramePainted(frame, message.replayed === true);
    };
    image.src = `data:image/jpeg;base64,${data}`;
  };

  const receive = (nextSocket: WebSocket, event: MessageEvent) => {
    if (stopped || socket !== nextSocket) return;
    let message: BrowserStreamMessage | null;
    try {
      message = browserStreamMessage(JSON.parse(String(event.data)));
    } catch {
      return;
    }
    if (!message) return;
    updateSourceHealth(message, health);
    if (message.type === "frame" && typeof message.data === "string") {
      receiveFrame(nextSocket, message, message.data);
      return;
    }
    handlers.onMessage(message);
  };

  const connect = () => {
    if (stopped) return;
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.close();
    if (clearBeforeConnect) target.context.clearRect(0, 0, target.canvas.width, target.canvas.height);
    handlers.onConnecting();

    const nextSocket = new WebSocket(streamUrl);
    socket = nextSocket;
    socketSlot.current = nextSocket;
    nextSocket.addEventListener("open", () => {
      if (stopped || socket !== nextSocket) return;
      handlers.onOpen();
    });
    nextSocket.addEventListener("close", () => {
      if (stopped || socket !== nextSocket) return;
      socket = null;
      if (socketSlot.current === nextSocket) socketSlot.current = null;
      handlers.onClose();
      if (reconnectDelayMs !== null && handlers.canReconnect()) {
        reconnectTimer = window.setTimeout(connect, reconnectDelayMs);
      }
    });
    nextSocket.addEventListener("error", () => {
      if (stopped || socket !== nextSocket) return;
      handlers.onError();
    });
    nextSocket.addEventListener("message", (event) => receive(nextSocket, event));
  };

  return { connect, stop };
}
