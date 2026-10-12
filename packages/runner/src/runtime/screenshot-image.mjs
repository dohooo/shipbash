// A screenshot as the model is shown it: the file the browser saved, at most
// SHOWN_PIXELS wide (never scaled up) and cut to its top SHOWN_PIXELS pixels,
// encoded as JPEG with ffmpeg. A viewport shot keeps all of itself; a full
// page keeps its top, legible, where scaling it whole would shrink its text
// past reading (the proxy tells the model so). Anything that goes wrong — no
// file, no ffmpeg, a run past its budget or cancelled, an answer too large —
// leaves the model the call's text alone, as it read it before.
import { execFile } from "node:child_process";

/** The widest and tallest a shown screenshot is, in pixels; a full page's result names it (agent-browser-downstream.mjs). */
export const SHOWN_PIXELS = 1_600;
/** ffmpeg's budget: it is killed past this, and the call answers in text. */
const TIMEOUT_MS = 15_000;
/** The largest JPEG a model is shown; a 1600 px viewport shot is about 80 KB. */
const MAX_BYTES = 4 * 1024 * 1024;

const SIDE = String(SHOWN_PIXELS);
const FILTER = `scale='min(iw,${SIDE})':-2,crop=iw:'min(ih,${SIDE})':0:0`;

/**
 * The saved screenshot at `path` as an image part for the model, or null.
 * @param {string} path
 * @param {AbortSignal} [signal] the call's: ffmpeg is killed when it aborts
 * @returns {Promise<{ type: "image", data: string, mimeType: "image/jpeg" } | null>}
 */
export function downscaledScreenshot(path, signal) {
  const args = ["-nostdin", "-v", "error", "-i", path, "-frames:v", "1", "-vf", FILTER,
    "-pix_fmt", "yuvj420p", "-q:v", "4", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"];
  return new Promise((resolve) => {
    execFile("ffmpeg", args, { encoding: "buffer", timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES, killSignal: "SIGKILL", signal },
      (error, jpeg) => resolve(error || jpeg.length === 0 ? null : { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" }));
  });
}
