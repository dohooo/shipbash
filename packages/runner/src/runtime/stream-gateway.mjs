/**
 * The single WebSocket gateway between viewers and the agent-browser runtime
 * stream. It replaces the former stream-bridge + browser-stream-proxy pair:
 * one component owns capability auth (hosted mode), agent_pointer injection,
 * and viewer fan-out in every deployment mode.
 *
 * The stream restarts on a fresh OS-assigned port whenever the agent moves to
 * another tab, so the runner announces the current upstream port through a
 * small channel file the gateway polls. Announcements never drop viewers:
 * each viewer's upstream socket is redialed while its own socket stays open,
 * so a tab hop shows a short frame gap instead of a reconnect flash.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import WebSocket, { WebSocketServer } from "ws";

import { startAgentPointerChannelReader } from "./agent-pointer.mjs";
import {
  FRAME_DROP_BUFFERED_BYTES,
  FRAME_DROP_MIN_MESSAGE_BYTES,
  createViewerOutbound,
  viewerMaxFps,
} from "./stream-viewer-outbound.mjs";

const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** The shared upstream announcement channel file inside a work directory. */
export function streamUpstreamChannelPath(workDirectory) {
  return join(workDirectory, "stream-upstream-channel");
}

/** Announces the current upstream stream port; null means no live stream. */
export async function announceStreamUpstream(channelPath, port) {
  await writeFile(channelPath, `${String(port ?? 0)}\n`);
}

function parseAnnouncedPort(content) {
  const value = Number(String(content).trim());
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535 ? value : null;
}

/**
 * The viewer upgrade guard: only a GET to the capability path (or "/" in local
 * mode), with no query beyond `maxFps` and the exact allowed Origin in hosted
 * mode, becomes a relay. Everything else is refused before a socket is ever
 * adopted. The connection event carries the viewer's parsed options.
 */
function installUpgradeGuard(server, websocketServer, auth) {
  server.on("upgrade", (request, socket, head) => {
    let requestedUrl;
    try {
      requestedUrl = new URL(request.url ?? "/", "http://gateway.invalid");
    } catch {
      socket.destroy();
      return;
    }
    const maxFps = viewerMaxFps(requestedUrl.searchParams);
    if (
      request.method !== "GET"
      || requestedUrl.pathname !== (auth ? auth.streamPath : "/")
      || maxFps === undefined
      || (auth !== null && request.headers.origin !== auth.allowedOrigin)
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      websocketServer.emit("connection", client, { maxFps });
    });
  });
}

/**
 * Reaps half-open viewer sockets so the viewer count stays honest: every
 * client must answer the previous tick's ping, or it is terminated on the
 * next tick. Returns a stop function for the gateway to clear on close.
 */
function startViewerHeartbeat(websocketServer) {
  websocketServer.on("connection", (client) => {
    client.isAlive = true;
    client.on("pong", () => {
      client.isAlive = true;
    });
  });
  const timer = setInterval(() => {
    for (const client of websocketServer.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 30_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * One viewer's relay: its own upstream socket, redialed whenever the announced
 * port changes or the upstream goes away, and the gap told to the viewer so a
 * tab hop never reads as a dead run. The port arrives as a getter because the
 * gateway keeps announcing new ones for the life of this relay.
 * @param {import("ws").WebSocket} client the viewer's socket.
 * @param {Set<{ redial: () => void }>} relays every live relay, so an
 *   announcement can reach this one and closing can drop it.
 * @param {{
 *   dialRetryDelayMs: number,
 *   frameDropBufferedBytes: number,
 *   frameDropMinMessageBytes: number,
 *   maxFps: number | null,
 *   upstreamPort: () => number | null,
 * }} options
 * @returns {void}
 */
function attachViewerRelay(client, relays, {
  dialRetryDelayMs,
  frameDropBufferedBytes,
  frameDropMinMessageBytes,
  maxFps,
  upstreamPort,
}) {
  const outbound = createViewerOutbound(client, { maxFps, frameDropBufferedBytes, frameDropMinMessageBytes });
  let upstream = null;
  let retryTimer = null;
  let closed = false;
  // The gateway is the only component that can tell a viewer "the runner is
  // alive but the picture is between streams" — without this, a stream gap
  // is indistinguishable from a dead run on the client.
  let announcedHealth = null;

  const sendHealth = (state) => {
    if (closed || announcedHealth === state || client.readyState !== WebSocket.OPEN) return;
    announcedHealth = state;
    client.send(JSON.stringify({ type: "gateway_status", upstream: state, relayedAt: Date.now() }));
  };

  const clearRetry = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };
  const scheduleRedial = () => {
    if (closed || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      dial();
    }, dialRetryDelayMs);
    retryTimer.unref?.();
  };
  const dial = () => {
    if (closed || upstream !== null || upstreamPort() === null) return;
    const socket = new WebSocket(`ws://127.0.0.1:${String(upstreamPort())}/`, {
      perMessageDeflate: false,
      maxPayload: MAX_PAYLOAD_BYTES,
    });
    upstream = socket;
    socket.on("open", () => {
      if (closed || upstream !== socket) return;
      sendHealth("connected");
    });
    socket.on("message", (data, isBinary) => {
      if (closed || upstream !== socket || client.readyState !== WebSocket.OPEN) return;
      outbound.send(data, isBinary);
    });
    const onGone = () => {
      if (upstream !== socket) return;
      upstream = null;
      sendHealth("connecting");
      scheduleRedial();
    };
    socket.on("close", onGone);
    socket.on("error", onGone);
  };

  client.on("message", (data, isBinary) => {
    if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
  });
  const closeRelay = () => {
    if (closed) return;
    closed = true;
    clearRetry();
    outbound.stop();
    relays.delete(relay);
    const active = upstream;
    upstream = null;
    active?.terminate();
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      client.close();
    }
  };
  client.on("close", closeRelay);
  client.on("error", closeRelay);

  const relay = {
    redial() {
      if (closed) return;
      const active = upstream;
      upstream = null;
      active?.terminate();
      clearRetry();
      sendHealth("connecting");
      dial();
    },
  };
  relays.add(relay);
  sendHealth("connecting");
  dial();
}

/**
 * @param {{
 *   listenPort: number,
 *   bindHost?: string,
 *   upstreamChannelPath: string,
 *   pointerChannelPath?: string | null,
 *   auth?: { allowedOrigin: string, streamPath: string } | null,
 *   pollIntervalMs?: number,
 *   dialRetryDelayMs?: number,
 *   frameDropBufferedBytes?: number,
 *   frameDropMinMessageBytes?: number,
 * }} options
 */
export async function startStreamGateway({
  listenPort,
  bindHost = "0.0.0.0",
  upstreamChannelPath,
  pointerChannelPath = null,
  /** { allowedOrigin, streamPath } for the hosted capability URL; null serves "/" without auth. */
  auth = null,
  pollIntervalMs = 100,
  dialRetryDelayMs = 250,
  frameDropBufferedBytes = FRAME_DROP_BUFFERED_BYTES,
  frameDropMinMessageBytes = FRAME_DROP_MIN_MESSAGE_BYTES,
}) {
  const server = createServer((_, response) => {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found.");
  });
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const stopHeartbeat = startViewerHeartbeat(websocketServer);
  const relays = new Set();
  let currentUpstreamPort = null;

  // Agent pointer events ride the same fast WebSocket as the screencast
  // frames, so the viewer's cursor keeps up with the page instead of trailing
  // on the slower persisted-event channel. The MCP proxy publishes each
  // pointer BEFORE the action is forwarded — by the time the click's frame
  // arrives, the cursor is already at the target.
  let lastPointerMessage = null;
  const pointerReader = pointerChannelPath
    ? startAgentPointerChannelReader(pointerChannelPath, (pointer) => {
        lastPointerMessage = JSON.stringify({ type: "agent_pointer", ...pointer, relayedAt: Date.now() });
        for (const client of websocketServer.clients) {
          if (client.readyState === WebSocket.OPEN) client.send(lastPointerMessage);
        }
      }, { intervalMs: 25 })
    : null;

  const applyUpstreamPort = (port) => {
    if (port === currentUpstreamPort) return;
    currentUpstreamPort = port;
    for (const relay of relays) relay.redial();
  };
  const pollUpstream = async () => {
    let content;
    try {
      content = await readFile(upstreamChannelPath, "utf8");
    } catch {
      return; // The channel may not exist yet.
    }
    applyUpstreamPort(parseAnnouncedPort(content));
  };
  const pollTimer = setInterval(() => {
    void pollUpstream();
  }, pollIntervalMs);
  pollTimer.unref?.();
  await pollUpstream();

  installUpgradeGuard(server, websocketServer, auth);

  websocketServer.on("connection", (client, viewer) => {
    // A late-joining viewer immediately learns the cursor's current position.
    if (lastPointerMessage) client.send(lastPointerMessage);
    attachViewerRelay(client, relays, {
      dialRetryDelayMs,
      frameDropBufferedBytes,
      frameDropMinMessageBytes,
      maxFps: viewer.maxFps,
      upstreamPort: () => currentUpstreamPort,
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, bindHost, resolve);
  });
  return {
    viewerCount: () => websocketServer.clients.size,
    async close() {
      clearInterval(pollTimer);
      stopHeartbeat();
      await pointerReader?.stop();
      for (const client of websocketServer.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
      websocketServer.close();
    },
  };
}

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function environmentPort(environment, name) {
  const value = Number(requiredEnvironment(environment, name));
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }
  return value;
}

function environmentAllowedOrigin(environment) {
  const url = new URL(requiredEnvironment(environment, "SHIPBASH_BROWSER_STREAM_ALLOWED_ORIGIN"));
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/") {
    throw new Error("SHIPBASH_BROWSER_STREAM_ALLOWED_ORIGIN must be a credential-free HTTPS origin.");
  }
  return url.origin;
}

function environmentStreamPath(environment) {
  const value = requiredEnvironment(environment, "SHIPBASH_BROWSER_STREAM_PATH");
  if (!/^\/stream\/[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error("SHIPBASH_BROWSER_STREAM_PATH is invalid.");
  }
  return value;
}

/**
 * Hosted-mode construction from the dispatcher-injected environment: the
 * public port, allowed Origin, and capability path arrive as
 * SHIPBASH_BROWSER_STREAM_* variables.
 */
export async function startStreamGatewayFromEnvironment(environment, options) {
  return startStreamGateway({
    listenPort: environmentPort(environment, "SHIPBASH_BROWSER_STREAM_PUBLIC_PORT"),
    auth: {
      allowedOrigin: environmentAllowedOrigin(environment),
      streamPath: environmentStreamPath(environment),
    },
    ...options,
  });
}
