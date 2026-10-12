import { isRecord } from "../is-record.ts";
import type { PublicRunStore } from "../store/public-run-store.ts";
import { unavailable } from "./public-media.ts";

type LiveSource = NonNullable<Awaited<ReturnType<PublicRunStore["readLiveSource"]>>>;
type LiveReader = Pick<PublicRunStore, "readLiveSource">;
type BrowserWire = Record<string, unknown>;

const LIVE_PATH = /^\/api\/public\/verifications\/([A-Za-z0-9_-]{43})\/live$/u;
const MAX_WIRE_BYTES = 2_000_000;
const MAX_CONNECTION_MS = 25_000;

function sourceKey(message: BrowserWire): string | null {
  return typeof message.sourceKey === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(message.sourceKey)
    ? message.sourceKey : null;
}

function publicPageUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

function publicFrame(message: BrowserWire, key: string): BrowserWire | null {
  if (typeof message.data !== "string"
    || !message.data || message.data.length > MAX_WIRE_BYTES
    || !/^[A-Za-z0-9+/=]+$/u.test(message.data)) return null;
  const url = publicPageUrl(message.url);
  if (!url || typeof message.title !== "string") return null;
  const generation = message.generation;
  const sequence = message.sequence;
  if (typeof generation !== "number" || typeof sequence !== "number"
    || !Number.isSafeInteger(generation) || !Number.isSafeInteger(sequence)
    || generation < 0 || sequence < 0) return null;
  return {
    type: "frame", sourceKey: key, generation, sequence,
    tabId: typeof message.tabId === "string" && message.tabId.length <= 128 ? message.tabId : null,
    url, title: message.title.slice(0, 160), data: message.data,
    replayed: message.replayed === true,
  };
}

/** Only sidecar picture/health fields cross the public boundary. */
export function publicBrowserMessage(message: BrowserWire): BrowserWire | null {
  if (message.type === "gateway_status") {
    return { type: "gateway_status", upstream: message.upstream === "connected" ? "connected" : "disconnected" };
  }
  const key = sourceKey(message);
  if (!key) return null;
  if (message.type === "status") {
    return {
      type: "status", sourceKey: key, connected: message.connected === true,
      screencasting: message.screencasting === true, blackout: message.blackout === true,
    };
  }
  return message.type === "frame" ? publicFrame(message, key) : null;
}

function parseSocketPicture(event: MessageEvent): BrowserWire | null {
  if (typeof event.data !== "string" || event.data.length > MAX_WIRE_BYTES + 4_096) return null;
  let raw: unknown;
  try { raw = JSON.parse(event.data); } catch { return null; }
  return isRecord(raw) ? publicBrowserMessage(raw) : null;
}

function createLiveBuffer(controller: ReadableStreamDefaultController<Uint8Array>, isClosed: () => boolean) {
  const encoder = new TextEncoder();
  const statuses = new Map<string, Uint8Array>();
  let frame: Uint8Array | null = null;
  const flush = () => {
    if (isClosed()) return;
    for (const type of ["run_state", "gateway_status", "status"]) {
      if (controller.desiredSize === null || controller.desiredSize <= 0) return;
      const bytes = statuses.get(type);
      if (bytes) { statuses.delete(type); controller.enqueue(bytes); }
    }
    if (frame && controller.desiredSize !== null && controller.desiredSize > 0) {
      controller.enqueue(frame);
      frame = null;
    }
  };
  return {
    flush,
    clear: () => { statuses.clear(); frame = null; },
    dropFrame: () => { frame = null; },
    send(value: BrowserWire) {
      if (isClosed()) return;
      const bytes = encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
      if (value.type === "frame") frame = bytes;
      else if (typeof value.type === "string") statuses.set(value.type, bytes);
      flush();
    },
  };
}

function liveBody(request: Request, source: LiveSource, read: () => Promise<LiveSource | null>): ReadableStream<Uint8Array> {
  let socket: WebSocket | null = null;
  let closed = false;
  let buffer: ReturnType<typeof createLiveBuffer> | null = null;
  let waitingForAuth = source.waitingForAuth;
  let timer: ReturnType<typeof setInterval> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let checking = false;
  let gatewayConnected = false;
  let healthySource = "";
  let blackedOut = false;
  let freshFrameSeen = false;
  let lastRetryAt = -Infinity;
  let closeStream = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      buffer = createLiveBuffer(controller, () => closed);
      const close = () => {
        if (closed) return;
        closed = true;
        buffer?.clear();
        if (timer) clearInterval(timer);
        if (deadline) clearTimeout(deadline);
        request.signal.removeEventListener("abort", close);
        socket?.close();
        try { controller.close(); } catch { /* The client may already have canceled the reader. */ }
      };
      closeStream = close;
      const send = (value: BrowserWire) => buffer?.send(value);
      const hidePicture = () => { buffer?.dropFrame(); freshFrameSeen = false; };
      const requestFreshFrame = () => {
        if (closed || waitingForAuth || blackedOut || !gatewayConnected || !healthySource || freshFrameSeen
          || !socket || socket.readyState !== WebSocket.OPEN
          || Date.now() - lastRetryAt < 8_000) return;
        lastRetryAt = Date.now();
        socket.send(JSON.stringify({ type: "stream_retry" }));
      };
      const check = async () => {
        if (checking || closed) return;
        checking = true;
        try {
          const current = await read();
          if (!current || current.streamUrl !== source.streamUrl) {
            close();
            return;
          }
          if (waitingForAuth !== current.waitingForAuth) {
            waitingForAuth = current.waitingForAuth;
            if (waitingForAuth) hidePicture();
            send({ type: "run_state", waitingForAuth });
          }
          requestFreshFrame();
        } catch { close(); } finally { checking = false; }
      };
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) { close(); return; }
      send({ type: "run_state", waitingForAuth });
      timer = setInterval(() => { void check(); }, 2_000);
      deadline = setTimeout(close, MAX_CONNECTION_MS);
      if (!source.streamUrl) return;
      const receiveGateway = (message: BrowserWire) => {
        gatewayConnected = message.upstream === "connected";
        if (!gatewayConnected) hidePicture();
        send(message);
        requestFreshFrame();
      };
      const receiveStatus = (message: BrowserWire) => {
        const key = String(message.sourceKey);
        if (message.blackout === true || message.connected !== true || message.screencasting !== true) hidePicture();
        send(message);
        if (key !== healthySource) freshFrameSeen = false;
        healthySource = message.connected === true && message.screencasting === true ? key : "";
        blackedOut = message.blackout === true;
        requestFreshFrame();
      };
      const receiveFrame = (message: BrowserWire) => {
        if (waitingForAuth || blackedOut) return;
        send(message);
        if (message.replayed !== true && gatewayConnected && healthySource === message.sourceKey) freshFrameSeen = true;
      };
      let connection: WebSocket;
      try { connection = new WebSocket(source.streamUrl); } catch { close(); return; }
      socket = connection;
      connection.addEventListener("open", requestFreshFrame);
      connection.addEventListener("message", (event) => {
        if (closed) return;
        const projected = parseSocketPicture(event);
        if (projected?.type === "gateway_status") receiveGateway(projected);
        else if (projected?.type === "status") receiveStatus(projected);
        else if (projected?.type === "frame") receiveFrame(projected);
      });
      connection.addEventListener("close", close);
      connection.addEventListener("error", close);
    },
    pull() { buffer?.flush(); },
    cancel() {
      closeStream();
    },
  });
}

export async function handlePublicLiveRequest(request: Request, store: LiveReader): Promise<Response> {
  if (request.method !== "GET") return unavailable();
  const url = new URL(request.url);
  const token = url.pathname.match(LIVE_PATH)?.[1];
  // The run whose browser this is, as the report names it (`eventsRunId`).
  const runId = url.searchParams.get("run");
  if (!token || !runId) return unavailable();
  const read = () => store.readLiveSource(token, runId);
  const source = await read();
  if (!source) return unavailable();
  return new Response(liveBody(request, source, read), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8", "cache-control": "private, no-store",
      "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow",
      "x-accel-buffering": "no", "connection": "keep-alive",
    },
  });
}
