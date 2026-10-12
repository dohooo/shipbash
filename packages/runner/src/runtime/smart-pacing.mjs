// Smart pacing: which stretches of a recording its replay plays sped up. The
// finalizer measures the browser's stillness on its own video (freezedetect)
// and hands this the playback document's pointers, attention and narration;
// every stretch nothing happens in, on either surface, plays in about
// SMART_PACING_TARGET_VIEW_MS, and the agent's moments, its narration and the
// screen each surface ends on play at 1x. The console's player and the
// exported replay both play the stretches the document carries.
import { readFile, rm } from "node:fs/promises";

import { attentionSegments } from "@shipbash/contracts/runtime/attention-track.mjs";
import { RECORDING_FRAME_RATE } from "@shipbash/contracts/runtime/recording-bounds.mjs";
import { captionReadingMs } from "@shipbash/contracts/runtime/recording-overlay-captions.mjs";

import { filterPath } from "./recording-command.mjs";

const SMART_PACING_FREEZE_NOISE = 0.003;
const SMART_PACING_FREEZE_DURATION_SECONDS = 2;
const SMART_PACING_CONTEXT_MS = 500;
const SMART_PACING_ACTION_GUARD_BEFORE_MS = 750;
const SMART_PACING_ACTION_GUARD_AFTER_MS = 1_250;
const SMART_PACING_MIN_SEGMENT_MS = 1_500;
const SMART_PACING_TARGET_VIEW_MS = 1_500;
const FRAME_MS = 1_000 / RECORDING_FRAME_RATE;

/**
 * The still stretches freezedetect found, from the frame metadata it wrote
 * (`lavfi.freezedetect.freeze_start=<s>` and `…freeze_end=<s>`, one per line);
 * a stretch still open where the video ends runs to its end.
 */
function parseFreezeDetectionOutput(value, durationMs) {
  const intervals = [];
  let activeStartMs = null;
  for (const line of String(value).split(/\r?\n/gu)) {
    const start = /freeze_start=([0-9]+(?:\.[0-9]+)?)/u.exec(line);
    if (start) {
      const parsed = Number(start[1]);
      if (Number.isFinite(parsed)) activeStartMs = Math.max(0, Math.round(parsed * 1_000));
    }
    const end = /freeze_end=([0-9]+(?:\.[0-9]+)?)/u.exec(line);
    if (end && activeStartMs !== null) {
      const parsed = Number(end[1]);
      const endMs = Number.isFinite(parsed)
        ? Math.min(durationMs, Math.max(0, Math.round(parsed * 1_000)))
        : activeStartMs;
      if (endMs > activeStartMs) intervals.push({ startMs: activeStartMs, endMs });
      activeStartMs = null;
    }
  }
  if (activeStartMs !== null && durationMs > activeStartMs) {
    intervals.push({ startMs: activeStartMs, endMs: durationMs });
  }
  return intervals;
}

function subtractInterval(segments, blocked) {
  return segments.flatMap((segment) => {
    if (blocked.endMs <= segment.startMs || blocked.startMs >= segment.endMs) return [segment];
    const result = [];
    if (blocked.startMs > segment.startMs) {
      result.push({ startMs: segment.startMs, endMs: Math.min(blocked.startMs, segment.endMs) });
    }
    if (blocked.endMs < segment.endMs) {
      result.push({ startMs: Math.max(blocked.endMs, segment.startMs), endMs: segment.endMs });
    }
    return result;
  });
}

/**
 * What the replay may skim on each surface it shows, in order, as the
 * attention track cuts the recording into them: in the browser, a stretch its
 * picture did not change in (`freezes`, from the browser's own video) less
 * SMART_PACING_CONTEXT_MS at either edge of the stillness; in a shell, all of
 * it, a command printing as much as a shell waiting.
 * @param {ReturnType<typeof attentionSegments>} surfaces
 * @param {Array<{ startMs: number, endMs: number }>} freezes
 */
function idleStretches(surfaces, freezes) {
  return surfaces.flatMap((surface) => (surface.surface === "terminal"
    ? [{ startMs: surface.startMs, endMs: surface.endMs }]
    : freezes.flatMap((freeze) => {
      const startMs = Math.max(surface.startMs, Math.round(freeze.startMs) + SMART_PACING_CONTEXT_MS);
      const endMs = Math.min(surface.endMs, Math.round(freeze.endMs) - SMART_PACING_CONTEXT_MS);
      return endMs > startMs ? [{ startMs, endMs }] : [];
    })));
}

/**
 * How long a narration line holds the picture: from where it starts until the
 * subtitle has been on screen as long as it needs to be read whole
 * (captionReadingMs), in whole frames of the replay: a line shows from the
 * first frame at or after its start, which can come up to a frame later, and
 * the sped-up stretches before it leave the replay's frames on no fixed phase
 * of the recording's, so the hold is one frame longer than the reading. Never
 * past the line's own window. Smart pacing plays it at 1x, and a Journey's
 * span keeps it (recording-journeys.mjs heldJourneys).
 * @param {{ startMs: number, endMs: number, caption: string }} cue
 */
export function readingHold({ startMs, endMs, caption }) {
  return { startMs, endMs: Math.min(endMs, startMs + captionReadingMs(caption) + FRAME_MS) };
}

/**
 * What plays at 1x on every surface: each of the agent's moments — a pointer
 * action in the browser; a call in a shell where it began (its command typed,
 * its keys sent) and where its answer came back (the output it waited for) —
 * from SMART_PACING_ACTION_GUARD_BEFORE_MS before to
 * SMART_PACING_ACTION_GUARD_AFTER_MS after; each narration line for as long as
 * the subtitle needs to show it whole within its own window (readingHold),
 * the picture held while it is read, as a burned-in caption cannot
 * outlast the picture it was said over — the one rule that keeps a line
 * readable, in the exported replay and in the console's player alike; and the last
 * SMART_PACING_TARGET_VIEW_MS of each surface's stretch: the screen the
 * replay cuts away from, and the one it ends on.
 * @param {ReturnType<typeof attentionSegments>} surfaces
 * @param {Array<{ atMs: number }>} pointers
 * @param {Array<{ atMs: number, answeredAtMs: number, surface: string }>} attention
 * @param {Array<{ startMs: number, endMs: number, caption: string }>} cues
 */
function guardedIntervals(surfaces, pointers, attention, cues) {
  const moments = [
    ...pointers.map(({ atMs }) => atMs),
    ...attention.filter((point) => point.surface === "terminal").flatMap((point) => [point.atMs, point.answeredAtMs]),
  ];
  return [
    ...moments.map((atMs) => ({ startMs: atMs - SMART_PACING_ACTION_GUARD_BEFORE_MS, endMs: atMs + SMART_PACING_ACTION_GUARD_AFTER_MS })),
    ...cues.map(readingHold),
    ...surfaces.map(({ endMs }) => ({ startMs: endMs - SMART_PACING_TARGET_VIEW_MS, endMs })),
  ];
}

/**
 * Smart pacing, in order: every idle stretch (idleStretches) outside the
 * agent's moments and its narration (guardedIntervals) plays in about
 * SMART_PACING_TARGET_VIEW_MS however long it lasted — a page settling and a
 * five-minute wait alike — and everything else at 1x. `pointers`,
 * `attention` and `cues` are on the video's timeline (recording-playback.mjs).
 * Every stretch is answered, in order: the finalizer shares the document's
 * bound between the walks (recording-finalize.mjs).
 * @param {{ freezes: Array<{ startMs: number, endMs: number }>, pointers?: Array<{ atMs: number }>, attention?: Array<{ atMs: number, answeredAtMs: number, surface: string, sessionId: string | null, label: string | null }>, cues?: Array<{ startMs: number, endMs: number, caption: string }>, durationMs: number }} input
 */
export function buildSmartPlaybackSegments({ freezes, pointers = [], attention = [], cues = [], durationMs }) {
  const surfaces = attentionSegments(attention, durationMs);
  const guards = guardedIntervals(surfaces, pointers, attention, cues);
  const segments = [];
  for (const stretch of idleStretches(surfaces, freezes)) {
    let candidates = [stretch];
    for (const blocked of guards) candidates = subtractInterval(candidates, blocked);
    for (const candidate of candidates) {
      const candidateDurationMs = candidate.endMs - candidate.startMs;
      if (candidateDurationMs < SMART_PACING_MIN_SEGMENT_MS) continue;
      const playbackRate = Math.max(2, Math.round(candidateDurationMs / SMART_PACING_TARGET_VIEW_MS));
      segments.push({ ...candidate, playbackRate, reason: "static" });
    }
  }
  return segments;
}

/**
 * The playback's idle stretches (buildSmartPlaybackSegments): the browser's
 * stillness measured on its own video, the agent's pointers, attention and
 * narration as the playback document placed them.
 * @param {string} videoPath
 * @param {number} durationMs
 * @param {{ pointers: Array<{ atMs: number }>, attention: Array<{ atMs: number, answeredAtMs: number, surface: string, sessionId: string | null, label: string | null }>, cues: Array<{ startMs: number, endMs: number, caption: string }> }} playback
 * @param {(command: string, args: string[]) => Promise<{ stdout: string, stderr: string }>} runCommand the finalizer's (recording-command.mjs runRecordingCommand)
 */
export async function detectSmartPlaybackSegments(videoPath, durationMs, { pointers, attention, cues }, runCommand) {
  // Every stretch, written to a file of its own: the command's own output is
  // kept only to its last 64 KB (recording-command.mjs), and a long
  // recording's stretches outrun that.
  const freezesPath = `${videoPath}.freezes.txt`;
  try {
    await runCommand("ffmpeg", [
      "-hide_banner", "-nostats", "-loglevel", "error",
      "-i", videoPath,
      "-vf", `freezedetect=noise=${String(SMART_PACING_FREEZE_NOISE)}:duration=${String(SMART_PACING_FREEZE_DURATION_SECONDS)},`
        + `metadata=mode=print:file=${filterPath(freezesPath)}`,
      "-an", "-f", "null", "-",
    ]);
    return buildSmartPlaybackSegments({
      freezes: parseFreezeDetectionOutput(await readFile(freezesPath, "utf8"), durationMs),
      pointers,
      attention,
      cues,
      durationMs,
    });
  } finally {
    await rm(freezesPath, { force: true });
  }
}
