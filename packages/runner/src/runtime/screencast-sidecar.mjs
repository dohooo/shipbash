/** Harness-owned CDP screencast endpoint for the gateway and recorder: one
 * port and one identity for the life of the browser it shows. Frames ride a
 * separate observer connection (screencast-source.mjs) so they cannot delay
 * agent commands, and a lost connection is attached again behind the same
 * port. The source's follower selects the visible tab; a lease gates all
 * viewer input. */
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import WebSocket, { WebSocketServer } from "ws";

import { STREAM_MAX_HEIGHT, STREAM_MAX_WIDTH } from "./browser-recording.mjs";
import { screencastBlackedOut, subscribeScreencastBlackout } from "./screencast-blackout.mjs";
import { createTakeoverControlPlane } from "./screencast-input.mjs";
import { browserGoneCause, openScreencastSource } from "./screencast-source.mjs";

const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
// Between attempts to attach a lost source again; the last one repeats.
const REATTACH_DELAYS_MS = [250, 750, 1_500, 3_000];
/** Stands in when no terminal lane rides this sidecar (suite runs). */
function inertTerminalLane() {
  return {
    /** @param {(message: object) => void} _broadcast */
    bind(_broadcast) {},
    joinMessages: () => /** @type {object[]} */ ([]),
    /** @param {Record<string, unknown>} _message */
    input(_message) {},
  };
}

/**
 * The stream's identity: the browser it shows, then this sidecar showing it.
 * `cdpUrl` names one Chromium instance by its browser id, which never leaves
 * the sidecar; its hash does. The instance part keeps a second sidecar over
 * the same browser, whose generations count from the start again, from being
 * read as older frames of the first.
 */
function sourceKeyFor(cdpUrl) {
  const browser = createHash("sha256").update(new URL(cdpUrl).pathname).digest("hex").slice(0, 16);
  return `${browser}.${randomBytes(4).toString("hex")}`;
}

/**
 * The picture's generation and the status that announces it. Each
 * discontinuity in the picture starts a generation, announced in a status at
 * once; every frame carries its own. The source reports its discontinuities
 * through `discontinue`, the blackout its own.
 */
function createGenerations(broadcast, { maxWidth, maxHeight }) {
  let generation = 0;
  let status = { connected: true, screencasting: true, engine: "chrome", recording: false, viewportWidth: maxWidth, viewportHeight: maxHeight };
  const announce = (changes = {}) => {
    status = { ...status, ...changes };
    broadcast({ type: "status", ...status, generation });
  };
  return {
    current: () => generation,
    announce,
    discontinue: (changes) => { generation += 1; announce(changes); },
  };
}

/** A joining viewer is seeded from retained state before it may send anything. */
function attachViewerSessions({ websocketServer, replayable, terminalLane, sendTo, control, requestFreshFrame }) {
  websocketServer.on("connection", (client) => {
    for (const type of ["status", "tabs", "url", "nav_state", "frame"]) {
      const last = replayable.get(type);
      if (last) client.send(type === "frame" ? JSON.stringify({ ...JSON.parse(last), replayed: true }) : last);
    }
    // Session list plus retained tails: a refreshed viewer keeps its scrollback.
    for (const message of terminalLane.joinMessages()) sendTo(client, message);
    sendTo(client, control.readOnlyState());
    client.on("message", (raw) => {
      try {
        if (JSON.parse(String(raw))?.type === "stream_retry") {
          void requestFreshFrame();
          return;
        }
      } catch { /* The control plane validates other viewer messages. */ }
      void control.handleViewerMessage(client, raw).catch(() => {});
    });
    client.on("close", () => {
      control.clientClosed(client);
    });
  });
}

/** A viewer may ask for a new frame of the page on screen; that is all a viewer can ask of the source. */
function createFreshFrameRequest({ closed, source }) {
  let inFlight = null;
  let lastRequestedAt = -Infinity;
  return () => {
    if (closed() || screencastBlackedOut()) return;
    if (inFlight || Date.now() - lastRequestedAt < 5_000) return;
    lastRequestedAt = Date.now();
    inFlight = source.requestFreshFrame().finally(() => { inFlight = null; });
  };
}

/**
 * The sidecar's source, kept on its browser. Everything that reaches the page
 * goes through one stable facade over the connection that is current; while
 * a lost connection is attached again there is none, and the facade answers
 * for it: a command fails at once, there is no attached page, and a tab hint
 * or a fresh-frame request does nothing. A connection becomes current the
 * moment it opens, so its first follow's page hooks reach it; one lost before
 * it attached leaves the gap open. The lost connection is attached again on
 * the same `cdpUrl` until it answers. A refusal proves the browser gone (its
 * port is closed, or the Chromium there does not know its id): that ends the
 * watch, and the caller hears it. Nothing else opens a source.
 *
 * The browser is silent from a loss for want of answers (two missed probes)
 * until a connection attaches again, and for good once it is gone. A
 * connection that only closed says nothing of the browser behind it: a live
 * one is attached again within seconds, and a dead one refuses at once.
 */
function keepSource({ open, closed, onSourceLost, onSourceRestored, onBrowserGone, generation }) {
  let current = null;
  let silent = false;
  const source = {
    send: (...args) => (current ? current.send(...args) : Promise.reject(new Error("The browser connection is being attached again."))),
    attachedSession: () => current?.attachedSession() ?? null,
    requestTab: (tabId) => current?.requestTab(tabId),
    followAgentTab: (url) => current?.followAgentTab(url),
    requestFreshFrame: async () => (current ? current.requestFreshFrame() : false),
    close: () => current?.close(),
  };
  const attach = () => {
    let self = null;
    return open({
      adopt: (opening) => {
        self = opening;
        current = opening;
      },
      onLost: (lost) => {
        if (self !== null && self === current) void reattach(self, lost);
      },
    });
  };
  async function reattach(lostSource, lost) {
    const lostAt = Date.now();
    current = null;
    lostSource.close();
    silent = lost.cause === "unresponsive";
    onSourceLost?.({ generation: generation(), cause: lost.cause });
    for (let attempt = 0; !closed(); attempt += 1) {
      await delay(REATTACH_DELAYS_MS[Math.min(attempt, REATTACH_DELAYS_MS.length - 1)]);
      if (closed()) return;
      try {
        await attach();
      } catch (error) {
        current = null;
        if (closed()) return;
        const gone = browserGoneCause(error);
        if (!gone) continue;
        silent = true;
        onBrowserGone?.({ cause: gone });
        return;
      }
      if (closed()) return;
      silent = false;
      onSourceRestored?.({ generation: generation(), gapMs: Date.now() - lostAt, cause: lost.cause });
      return;
    }
  }
  return {
    source,
    browserSilent: () => silent,
    async start() {
      await (await attach()).followed;
    },
  };
}

/** Add the sidecar's opaque identity to only source-health and pixel messages. */
function serializeBroadcast(message, sourceKey) {
  return JSON.stringify(message.type === "status" || message.type === "frame"
    ? { ...message, sourceKey, ...(message.type === "status" ? { blackout: screencastBlackedOut() } : {}) }
    : message);
}

/**
 * A credential blackout's start and its lift each start a generation. The
 * lift also asks for a fresh frame: a still page sends none on its own, and
 * every audience would keep the picture from before the blackout.
 */
function bindBlackoutStatus({ announce, discontinue }, source) {
  const unsubscribe = subscribeScreencastBlackout((on) => {
    discontinue();
    if (!on) void source.requestFreshFrame();
  });
  announce();
  return unsubscribe;
}

/** The handle the caller drives the sidecar with; close() is its teardown order. */
function createSidecarHandle(port, { server, websocketServer, replayable, source, browserSilent, unsubscribeBlackout, markClosed }) {
  return {
    port,
    /** Whether the browser stopped answering and has not answered since, or is gone (keepSource). @returns {boolean} */
    browserSilent,
    /** The agent's working tab by url (the daemon's tab list after a tab tool). @param {string} url */
    followAgentTab(url) {
      source.followAgentTab(url);
    },
    /** Retain the last frame before close(). @param {string} path @returns {Promise<boolean>} */
    async retainFinalFrame(path) {
      const last = replayable.get("frame");
      if (!last) return false;
      try {
        const data = JSON.parse(last)?.data;
        if (typeof data !== "string" || !data) return false;
        await writeFile(path, Buffer.from(data, "base64"));
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      markClosed();
      unsubscribeBlackout();
      source.close();
      for (const client of websocketServer.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
      websocketServer.close();
    },
  };
}

export async function startScreencastSidecar({
  cdpUrl,
  quality = 70,
  // Viewers and recordings receive downscaled frames.
  maxWidth = STREAM_MAX_WIDTH,
  maxHeight = STREAM_MAX_HEIGHT,
  // ~12fps: Chromium sends the next frame only after the previous ack.
  frameIntervalMs = 80,
  /**
   * The source's connection was lost, at the moment it was: the generation
   * that started, and why (`socket_closed`, or `unresponsive` after two
   * missed probes). The sidecar attaches again until it answers or refuses.
   */
  onSourceLost = /** @type {((lost: { generation: number, cause: string }) => void) | null} */ (null),
  /** A lost source attached again to the same browser: its generation, how long the picture was gone, and why it was lost. */
  onSourceRestored = /** @type {((restored: { generation: number, gapMs: number, cause: string }) => void) | null} */ (null),
  /**
   * The browser this sidecar showed is gone: attaching again was refused
   * (`refused`: nothing listens on its port; `unknown_browser`: the Chromium
   * there does not know its id). Any browser after it is another one. Every
   * viewer hears it first, in a status that says `gone` for good: a recorder
   * waiting on a step's picture stops waiting (evidence-recorder.mjs).
   */
  onBrowserGone = /** @type {((gone: { cause: string }) => void) | null} */ (null),
  /** Current takeover lease from the mounted control directory. */
  readControlToken = /** @type {(() => Promise<string | null> | string | null) | null} */ (null),
  /** Maps a client-chosen upload basename to a container path, or null to refuse. */
  resolveUploadPath = /** @type {((name: string) => string | null) | null} */ (null),
  /** Container directory that silently receives takeover downloads. */
  downloadDirectory = /** @type {string | null} */ (null),
  /** Terminal messages share this socket and the control lease. */
  terminalLane = inertTerminalLane(),
  /** Scripts injected before each mirrored page's own scripts. */
  initScripts = /** @type {string[]} */ ([]),
}) {
  const server = createServer((_, response) => {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found.");
  });
  const websocketServer = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD_BYTES });
  const replayable = new Map(); // message type → last serialized message
  const sourceKey = sourceKeyFor(cdpUrl);
  const broadcast = (message) => {
    const serialized = serializeBroadcast(message, sourceKey);
    replayable.set(message.type, serialized);
    for (const client of websocketServer.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(serialized);
    }
  };
  const sendTo = (client, message) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  };
  terminalLane.bind(broadcast);
  const generations = createGenerations(broadcast, { maxWidth, maxHeight });

  let closed = false;
  const sources = keepSource({
    open: (hooks) => openScreencastSource({
      cdpUrl, broadcast, control,
      announce: generations.announce, discontinue: generations.discontinue, generation: generations.current,
      quality, maxWidth, maxHeight, frameIntervalMs, initScripts, downloadDirectory, ...hooks,
    }),
    closed: () => closed,
    generation: generations.current,
    onSourceLost,
    onSourceRestored,
    onBrowserGone: (gone) => {
      generations.announce({ gone: true });
      onBrowserGone?.(gone);
    },
  });
  const { source } = sources;
  // The control plane is the sidecar's; it reaches the page through the source's facade.
  const control = createTakeoverControlPlane({
    send: source.send,
    sendTo,
    broadcast,
    readControlToken,
    resolveUploadPath,
    terminalLane,
    activateTab: source.requestTab,
    attachedSession: source.attachedSession,
  });
  const requestFreshFrame = createFreshFrameRequest({ closed: () => closed, source });
  attachViewerSessions({ websocketServer, replayable, terminalLane, sendTo, control, requestFreshFrame });
  await sources.start();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Screencast sidecar could not bind a port.");
  const unsubscribeBlackout = bindBlackoutStatus(generations, source);
  return createSidecarHandle(address.port, {
    server, websocketServer, replayable, source, browserSilent: sources.browserSilent, unsubscribeBlackout, markClosed: () => { closed = true; },
  });
}
