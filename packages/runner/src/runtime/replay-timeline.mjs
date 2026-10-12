// The exported replay's timeline: the paced time the replay is encoded on and
// its overlay is drawn on.
//
// Smart pacing plays every idle stretch the finalizer found at its rate
// (recording-timeline.mjs is the one mapping; the console's player reads it
// too), on whichever surface is on screen: the finalizer found each one on
// its own surface (smart-pacing.mjs buildSmartPlaybackSegments). The
// export cuts the recording where the surface or the rate changes, speeds
// each piece up by its rate, and draws the burned-in overlay on the result —
// so the overlay is computed on the same paced timeline: its clock, its
// chapters, its points and its narration all say where they fall in the video
// being watched.
//
// A walk that marked the Journeys it proved is cut to them: everything outside
// the kept spans is a stretch the paced timeline plays in no time at all, on
// every surface, and the Journeys are the replay's chapters.

import {
  deriveBrowserRecordingChapters,
  pacedTime,
  pacedTimeline,
} from "@shipbash/contracts/runtime/recording-timeline.mjs";

import { onFrameGrid } from "./browser-recording.mjs";

/** A stretch of one span that another overlaps, or nothing. */
function overlap(span, other) {
  const startMs = Math.max(span.startMs, other.startMs);
  const endMs = Math.min(span.endMs, other.endMs);
  return endMs > startMs ? { startMs, endMs } : null;
}

/** A span with its edges moved onto the frame grid (browser-recording.mjs onFrameGrid). */
function onFrames(span, durationMs) {
  return { ...span, startMs: onFrameGrid(span.startMs, durationMs), endMs: onFrameGrid(span.endMs, durationMs) };
}

/**
 * Everything outside the kept spans (on the frame grid already: the
 * finalizer placed them, recording-journeys.mjs), as stretches played at an
 * infinite rate: the paced timeline gives them no length, and every moment
 * inside one lands on the seam after it. None when nothing is kept, which is
 * the whole recording; a keep that holds no frame leaves nothing to encode.
 * @param {ReadonlyArray<{ startMs: number, endMs: number }>} keep
 * @param {number} durationMs
 */
function cutStretches(keep, durationMs) {
  if (keep.length === 0) return [];
  const kept = keep.filter((span) => span.endMs > span.startMs).sort((left, right) => left.startMs - right.startMs);
  if (kept.length === 0) throw new Error("The Journeys the walk marked hold none of its recording.");
  const cuts = [];
  let fromMs = 0;
  for (const span of [...kept, { startMs: durationMs, endMs: durationMs }]) {
    if (span.startMs > fromMs) cuts.push({ startMs: fromMs, endMs: span.startMs, playbackRate: Number.POSITIVE_INFINITY });
    fromMs = Math.max(fromMs, span.endMs);
  }
  return cuts;
}

/**
 * The replay's cut: its surface segments and its paced timeline, every edge on
 * the frame grid, so the encoded pieces and the overlay drawn over them share
 * frame-exact bounds. The stretches outside `keep` are cut, and come before
 * the idle ones, so a cut wins over an idle rate (pacedRate takes the first
 * stretch that holds a moment).
 * @param {import("./recording-playback.mjs").Playback["speedSegments"]} speedSegments the playback document's idle stretches
 * @param {Array<{ startMs: number, endMs: number, surface: string, sessionId?: string | null }>} segments the replay's surfaces
 * @param {number} durationMs
 * @param {ReadonlyArray<{ startMs: number, endMs: number }>} [keep] the spans the replay keeps; none keeps it whole
 */
export function replayCut(speedSegments, segments, durationMs, keep = []) {
  const snapped = segments.map((segment) => onFrames(segment, durationMs)).filter((segment) => segment.endMs > segment.startMs);
  const idle = speedSegments.map((stretch) => onFrames(stretch, durationMs));
  return { segments: snapped, timeline: pacedTimeline([...cutStretches(keep, durationMs), ...idle], durationMs) };
}

/**
 * The replay's pieces: each surface segment cut again wherever pacing changes
 * its rate, in timeline order, each with the rate it plays at. A cut stretch
 * is no piece at all.
 * @param {Array<{ startMs: number, endMs: number, surface: string, sessionId?: string | null }>} segments
 * @param {ReturnType<typeof pacedTimeline>} timeline
 */
export function pacedSegments(segments, timeline) {
  return segments.flatMap((segment) => timeline.flatMap((stretch) => {
    const shared = Number.isFinite(stretch.rate) ? overlap(segment, stretch) : null;
    return shared ? [{ ...segment, ...shared, rate: stretch.rate }] : [];
  }));
}

/** Whether a moment of the recording falls in a stretch the replay cuts. */
function cut(timeline, atMs) {
  const stretch = timeline.find((candidate) => atMs >= candidate.startMs && atMs < candidate.endMs);
  return stretch !== undefined && !Number.isFinite(stretch.rate);
}

/**
 * The replay's chapters: the narration's, or, for a replay cut to the
 * Journeys a walk marked, one per Journey from where its span starts, each
 * lasting until the next begins.
 */
function sourceChapters(cues, keep, durationMs) {
  if (keep.length === 0) return deriveBrowserRecordingChapters(cues, durationMs);
  const starts = keep.map((span, index) => ({
    startMs: span.startMs, chapterId: `journey-${String(index + 1)}`, chapterTitle: span.title,
  }));
  return deriveBrowserRecordingChapters(starts, durationMs);
}

/**
 * The recording as the overlay reads it (the shared module's OverlayRecording),
 * every moment moved onto the replay's paced timeline. What is said or pointed
 * at inside a cut is not in the video, so it is dropped; a move between
 * surfaces inside one lands on the seam, so the stretch after it starts on
 * the right one.
 * @param {Pick<import("./recording-playback.mjs").Playback, "cues" | "pointers" | "attention">} playback
 * @param {number} durationMs the recording's own length
 * @param {ReturnType<typeof pacedTimeline>} timeline
 * @param {ReadonlyArray<{ startMs: number, endMs: number, title: string }>} [keep] the Journeys a cut replay keeps, as its chapters
 * @returns {import("@shipbash/contracts/runtime/recording-overlay.mjs").OverlayRecording}
 */
export function pacedOverlayRecording(playback, durationMs, timeline, keep = []) {
  const at = (ms) => pacedTime(timeline, ms);
  const shown = (moments) => moments.filter((moment) => !cut(timeline, moment.startMs ?? moment.atMs));
  const pacedDurationMs = at(durationMs);
  const cues = shown(playback.cues);
  return {
    durationMs: pacedDurationMs,
    chapters: sourceChapters(cues, keep, durationMs)
      .map((chapter) => ({ ...chapter, startMs: at(chapter.startMs), endMs: at(chapter.endMs) }))
      .filter((chapter) => chapter.endMs > chapter.startMs),
    // Readable as smart pacing made them: each line's window plays at 1x for as long as reading it takes.
    cues: cues.map((cue) => ({ startMs: at(cue.startMs), endMs: at(cue.endMs), caption: cue.caption })),
    pointers: shown(playback.pointers).map((pointer) => ({ atMs: at(pointer.atMs) })),
    attention: playback.attention.map((point) => ({ ...point, atMs: at(point.atMs) })),
  };
}
