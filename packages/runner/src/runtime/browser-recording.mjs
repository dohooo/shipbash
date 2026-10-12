import { join } from "node:path";

import {
  BROWSER_RECORDING_EXTENSION,
  BROWSER_RECORDING_FILE,
  BROWSER_RECORDING_POSTER_FILE,
} from "@shipbash/contracts/runtime/browser-recording-format.mjs";
import { RECORDING_FRAME_RATE } from "@shipbash/contracts/runtime/recording-bounds.mjs";

// What the agent gets to see at once. A 720p viewport put only a fraction of
// a real product page on screen (measured on a docs page: 58 of 240
// interactive elements in view, vs 74 at this size), and a narrow viewport
// also risks tripping a product's mobile breakpoint, which would have the
// agent verify a layout no desktop user sees. Streaming and recording are
// unaffected: the screencast downscales every frame to STREAM_MAX_* below,
// so the viewer's bandwidth and the recording's size do not change.
export const BROWSER_RECORDING_WIDTH = 1920;
export const BROWSER_RECORDING_HEIGHT = 1080;
/** The frame size viewers and the recording actually receive. */
export const STREAM_MAX_WIDTH = 1280;
export const STREAM_MAX_HEIGHT = 720;
/**
 * H.264, the same line for the live segment encoder and for the concat
 * fallback so a recording looks the same whichever path produced it.
 *
 * Screen content is what this is tuned for: text that has to stay readable
 * over long stretches where nothing moves. Measured on a 60 s 1280x720
 * synthetic console recording at 10 fps, encoding on 2 threads to match the
 * Sandbox, against the VP9 line this replaces (0.64 MB, 1.0 s, SSIM 0.9975):
 * 0.39 MB, 0.5 s, SSIM 0.9981 — smaller, faster and slightly sharper.
 * `stillimage` is what buys the last of that: it lowers deblocking, which is
 * exactly wrong for camera footage and exactly right for glyph edges.
 */
export const BROWSER_RECORDING_ENCODE_ARGS = Object.freeze([
  "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage",
  "-crf", "23", "-pix_fmt", "yuv420p",
]);

/**
 * A live segment is written as fragmented MP4, because the runs whose
 * recording matters most are the ones that die. A plain MP4 keeps its index
 * in memory until a clean close, so a killed encoder leaves a file with no
 * `moov` at all — measured: 48 bytes, "moov atom not found", the whole
 * segment gone. Fragments carry their own index, so everything written
 * before the kill still plays.
 *
 * Both of the last two arguments are load-bearing, and neither is obvious:
 *
 * - `+frag_keyframe` alone fragments on keyframes, and this encode's GOP is
 *   250 frames — 25 seconds at 10 fps. `-frag_duration` gives fragments a
 *   cadence of their own instead of buying one with extra keyframes, which
 *   measured 4x larger.
 * - without `-flush_packets`, finished fragments sit in the muxer's buffer
 *   and a kill loses them anyway (measured: 28 bytes, same total loss).
 *
 * Measured together on a killed encoder: 87 KB, probes as h264 1280x720,
 * duration exact. Closing is instant, which also matters — `+faststart`
 * here would rewrite the whole file at close, lengthening the very window
 * this protects against.
 */
export const BROWSER_RECORDING_FRAGMENT_ARGS = Object.freeze([
  "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
  "-frag_duration", "2000000",
  "-flush_packets", "1",
]);

/**
 * The delivered file is an ordinary MP4 with its index at the front, so a
 * player can start on its first range request instead of fetching the tail.
 * Finalization always remuxes into this, whether there was one segment or
 * several.
 */
export const BROWSER_RECORDING_FASTSTART_ARGS = Object.freeze(["-movflags", "+faststart"]);

const FRAME_MS = 1_000 / RECORDING_FRAME_RATE;

/**
 * A moment of the recording moved onto its frame grid, the recording's own
 * ends kept. freezedetect, the attention track and a Journey's marks fall on
 * arbitrary milliseconds; a piece cut between two frames keeps a whole frame
 * the paced timeline gives only part of, and over many sped-up pieces the
 * video and its overlay drift apart. `snap` picks the frame: the nearest, or
 * the one before (Math.floor) or after (Math.ceil) for an edge that must keep
 * every frame it touches.
 * @param {number} ms
 * @param {number} durationMs the recording's length
 * @param {(frames: number) => number} [snap]
 */
export function onFrameGrid(ms, durationMs, snap = Math.round) {
  if (ms <= 0 || ms >= durationMs) return Math.min(Math.max(ms, 0), durationMs);
  return Math.min(snap(ms / FRAME_MS) * FRAME_MS, durationMs);
}

export function recordingSegmentPath(directory, executionRound = 1) {
  return join(directory, `browser-recording-segment-${String(executionRound)}${BROWSER_RECORDING_EXTENSION}`);
}

export function recordingOutputPaths(directory) {
  return {
    videoPath: join(directory, BROWSER_RECORDING_FILE),
    posterPath: join(directory, BROWSER_RECORDING_POSTER_FILE),
  };
}

export function parseRecordingMetadata(value) {
  const stream = Array.isArray(value?.streams) ? value.streams[0] : null;
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  const durationSeconds = Number(value?.format?.duration);
  if (
    !Number.isInteger(width) || width < 1 ||
    !Number.isInteger(height) || height < 1 ||
    !Number.isFinite(durationSeconds) || durationSeconds <= 0
  ) {
    throw new Error("ffprobe returned invalid browser recording metadata.");
  }
  return {
    width,
    height,
    durationMs: Math.max(1, Math.round(durationSeconds * 1_000)),
  };
}
