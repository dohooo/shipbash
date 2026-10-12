import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

import WebSocket from "ws";

import { RECORDING_FRAME_RATE } from "@shipbash/contracts/runtime/recording-bounds.mjs";

import {
  BROWSER_RECORDING_ENCODE_ARGS,
  BROWSER_RECORDING_FRAGMENT_ARGS,
  STREAM_MAX_HEIGHT,
  STREAM_MAX_WIDTH,
} from "./browser-recording.mjs";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 30_000;
const MAX_FRAME_BASE64_LENGTH = 16 * 1024 * 1024;

function safeOutputPath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || /[\r\n]/u.test(path)) {
    throw new Error("Browser stream recording outputPath must be a safe absolute path.");
  }
  return path;
}

function frameFromBrowserStreamMessage(data) {
  let message;
  try {
    message = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
  } catch {
    return null;
  }
  if (
    !message
    || typeof message !== "object"
    || message.type !== "frame"
    || typeof message.data !== "string"
    || message.data.length === 0
    || message.data.length > MAX_FRAME_BASE64_LENGTH
  ) {
    return null;
  }
  const frame = Buffer.from(message.data, "base64");
  // agent-browser's stream contract is JPEG. Reject malformed messages before
  // they can poison the encoder and the entire evidence finalization path.
  if (frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8) return null;
  return frame;
}

function createFfmpegEncoder(outputPath, frameRate, spawnProcess = spawn) {
  const child = spawnProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    // No input probing: the stream is declared mjpeg below, so ffmpeg opens
    // the output file on the first frame instead of buffering frames while
    // it sniffs a format it already knows (agent-browser's record does the
    // same).
    "-probesize", "32", "-analyzeduration", "0", "-fpsprobesize", "0",
    "-f", "image2pipe", "-framerate", String(frameRate), "-vcodec", "mjpeg", "-i", "pipe:0",
    // image2pipe locks the output size to whatever the first frame happens to
    // be, so a browser window that was still small when recording began
    // squeezed every later frame into it (measured: a 1920x1080 run produced a
    // 640x662 video). Pinning the frame instead means a window that changes
    // size mid-run — which is exactly what a human takeover does — is
    // letterboxed into the geometry the recording's metadata promises rather
    // than reshaping or distorting the video.
    // out_range=tv converts the screencast's full-range JPEG frames to the
    // limited range H.264 is normally delivered in. The bytes are the same
    // picture either way, but a full-range flag is the one thing players
    // still disagree about, and a recording that renders washed out in Slack
    // is worth more than the 4% of size the conversion happens to save.
    "-vf", `scale=${String(STREAM_MAX_WIDTH)}:${String(STREAM_MAX_HEIGHT)}:force_original_aspect_ratio=decrease:out_range=tv,pad=${String(STREAM_MAX_WIDTH)}:${String(STREAM_MAX_HEIGHT)}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`,
    "-an", ...BROWSER_RECORDING_ENCODE_ARGS, ...BROWSER_RECORDING_FRAGMENT_ARGS,
    outputPath,
  ], {
    shell: false,
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  let closed = false;
  let closeResult = null;
  let ending = false;
  let failure = null;
  const failureListeners = [];
  // An encoder that dies mid-recording says so once: a dead stdin never
  // drains, so without this the recorder would keep filling slots for it.
  const fail = (error) => {
    if (failure) return;
    failure = error;
    for (const listener of failureListeners) listener(error);
  };
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_000);
  });
  child.stdin.on("error", fail);
  const completed = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      fail(error);
      reject(error);
    });
    child.once("close", (code) => {
      closed = true;
      closeResult = code;
      const exited = new Error(`ffmpeg browser stream recording exited with code ${String(code)}: ${stderr}`);
      if (!ending) fail(exited);
      if (code === 0) resolve();
      else reject(exited);
    });
  });
  // The runner awaits the same promise during close. Attach a handler now so
  // an encoder failure cannot become an unhandled rejection in the meantime.
  completed.catch(() => {});
  return {
    write(frame) {
      if (closed || child.stdin.destroyed || child.stdin.writableEnded) return false;
      return child.stdin.write(frame);
    },
    onDrain(callback) {
      child.stdin.once("drain", callback);
    },
    onFailure(callback) {
      if (failure) callback(failure);
      else failureListeners.push(callback);
    },
    async close(timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS) {
      ending = true;
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      if (closed && closeResult === 0) return;
      let timeout;
      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              child.kill("SIGKILL");
              reject(new Error("ffmpeg timed out while closing browser stream recording."));
            }, timeoutMs);
            timeout.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/** How far the encoder may fall behind before the oldest pictures give way. */
const MAX_BACKLOG_SECONDS = 5;

/**
 * The slots the encoder has not taken yet, as runs of one picture, so memory
 * follows how many pictures there are and not how long they last. An encoder
 * more than MAX_BACKLOG_SECONDS behind keeps the time and gives up detail:
 * the oldest run merges into the picture that followed it, so the video
 * still lasts as long as the walk did and only pictures in between are lost.
 * @param {number} frameRate
 */
function createSlotBacklog(frameRate) {
  const runs = [];
  const limit = MAX_BACKLOG_SECONDS * frameRate;
  let slots = 0;
  return {
    slots: () => slots,
    add(frame, count) {
      if (count <= 0) return;
      const last = runs.at(-1);
      if (last?.frame === frame) last.count += count;
      else runs.push({ frame, count });
      slots += count;
      while (runs.length > 1 && slots - runs[0].count > limit) {
        runs[1].count += runs[0].count;
        runs.shift();
      }
    },
    /** The oldest slot's picture, taken off the backlog. */
    take() {
      const run = runs[0];
      run.count -= 1;
      slots -= 1;
      if (run.count === 0) runs.shift();
      return run.frame;
    },
  };
}

/**
 * The video's clock, and the encoder it feeds. The encoder numbers frames at
 * `frameRate`, so frame k is slot k: the slot that begins k/frameRate after
 * the first frame. Every slot that has begun is filled with the picture
 * showing at its start, so the video keeps wall time from its first frame
 * however late the timer fires or however long the encoder takes to drain —
 * the writes wait, the slots do not. Playwright's recorder keeps its video on
 * time the same way, repeating its last frame to cover the time since that
 * frame arrived. Filling one slot per timer tick instead lost 0.8–1.0 s of
 * every 38 s with one CPU and four busy processes
 * (measured). An encoder that fails stops the
 * video where it is: nothing more is filled or written.
 * @param {{ path: string, frameRate: number, now: () => number, encoderFactory: typeof createFfmpegEncoder }} options
 */
function createSlotVideo({ path, frameRate, now, encoderFactory }) {
  let firstFrameAtMs = null;
  let latest = null;
  let filled = 0;
  const backlog = createSlotBacklog(frameRate);
  let encoder = null;
  let draining = false;
  const state = { frameWrites: 0, error: null };
  const fail = (error) => {
    state.error ??= error;
  };
  const fill = () => {
    if (state.error) return;
    const begun = Math.floor(((now() - firstFrameAtMs) * frameRate) / 1_000) + 1;
    backlog.add(latest, begun - filled);
    filled = Math.max(filled, begun);
  };
  const opened = () => {
    if (!encoder) {
      encoder = encoderFactory(path, frameRate);
      encoder.onFailure(fail);
    }
    return encoder;
  };
  /** The backlog, in order; only an ending input is fed past a full pipe. */
  const feed = (ending = false) => {
    while ((ending || !draining) && !state.error && backlog.slots() > 0) {
      try {
        const accepted = opened().write(backlog.take());
        state.frameWrites += 1;
        if (!accepted && !draining && !ending) {
          draining = true;
          encoder.onDrain(() => {
            draining = false;
            feed();
          });
        }
      } catch (error) {
        fail(error);
      }
    }
  };
  return {
    state,
    fail,
    /** A new picture from the next slot on; the first one's reading of `now` is slot 0's. */
    show(frame) {
      const first = firstFrameAtMs === null;
      if (first) firstFrameAtMs = now();
      // The picture being replaced keeps the slots up to this one.
      else fill();
      latest = frame;
      fill();
      feed();
      return first ? firstFrameAtMs : null;
    },
    /** Every slot begun by now, filled with the picture showing. */
    tick() {
      if (latest) fill();
      feed();
    },
    /** The picture showing runs to the stop; the encoder's stdin delivers every slot before it ends. */
    async close(timeoutMs) {
      if (latest) fill();
      feed(true);
      if (encoder) await encoder.close(timeoutMs);
    },
  };
}

/**
 * Records the same CDP screencast frames used by the live viewer. This is
 * deliberately independent from `agent-browser record` (measured against
 * 0.37.1): record does not follow tab switches, its output size follows the
 * tab viewport, its VP8 bitrate ceiling is fixed, its 30fps on 2 vCPU drops
 * wall-clock time (13–19 s per 30 s), and a second screencast raises agent
 * command p90 from 8 ms to 28 ms. Recording here is a passive consumer of
 * the sidecar's frames and can never block snapshots, clicks, or navigation.
 *
 * The video starts at the first frame written, not when recording starts:
 * Chromium sends its first frame only once it composites the page, which
 * took 4–6 s after the stream opened on a busy Sandbox
 * (measured). `onFirstFrame(atMs)` hands on the
 * reading of `now` that frame took slot 0 at, so the overlays are timed from
 * that one reading (recording-capture.mjs).
 */
export async function startBrowserStreamRecording({
  upstreamPort,
  outputPath,
  frameRate = RECORDING_FRAME_RATE,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
  WebSocketConstructor = WebSocket,
  encoderFactory = createFfmpegEncoder,
  onFirstFrame = (/** @type {number} */ _atMs) => {},
  now = () => performance.now(),
}) {
  if (!Number.isSafeInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65_535) {
    throw new Error("Browser stream recording upstreamPort must be a valid TCP port.");
  }
  if (!Number.isSafeInteger(frameRate) || frameRate < 1 || frameRate > 30) {
    throw new Error("Browser stream recording frameRate must be between 1 and 30.");
  }
  const path = safeOutputPath(outputPath);
  await mkdir(dirname(path), { recursive: true });

  const socket = new WebSocketConstructor(`ws://127.0.0.1:${String(upstreamPort)}/`, {
    perMessageDeflate: false,
    maxPayload: 8 * 1024 * 1024,
  });
  const video = createSlotVideo({ path, frameRate, now, encoderFactory });
  let timer = null;
  let closed = false;

  socket.on("message", (data) => {
    const frame = frameFromBrowserStreamMessage(data);
    if (!frame || closed) return;
    const firstFrameAtMs = video.show(frame);
    if (firstFrameAtMs === null) return;
    onFirstFrame(firstFrameAtMs);
    timer = setInterval(video.tick, Math.round(1_000 / frameRate));
    timer.unref?.();
  });
  socket.on("error", (error) => {
    if (!closed) video.fail(error);
  });

  await new Promise((resolve, reject) => {
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("open", opened);
      socket.off("error", failed);
    };
    const opened = () => {
      cleanup();
      resolve();
    };
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    socket.once("open", opened);
    socket.once("error", failed);
    timeout = setTimeout(() => {
      cleanup();
      socket.terminate();
      reject(new Error("Browser stream recording timed out while connecting."));
    }, connectTimeoutMs);
    timeout.unref?.();
  });

  return {
    async close() {
      const { state } = video;
      if (closed) return { frameWrites: state.frameWrites };
      closed = true;
      if (timer) clearInterval(timer);
      if (socket.readyState === WebSocketConstructor.OPEN || socket.readyState === WebSocketConstructor.CONNECTING) {
        socket.terminate();
      }
      await video.close(closeTimeoutMs);
      if (state.error && state.frameWrites === 0) throw state.error;
      return { frameWrites: state.frameWrites };
    },
  };
}
