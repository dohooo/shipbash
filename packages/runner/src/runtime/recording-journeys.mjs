// The Journeys a walk marked (mark_journey), as the replay keeps them: their
// spans, where each opens, what was said before it, and where they lie on the
// video, on the frame grid, and how long each is kept. The playback builder
// places them (recording-playback.mjs), the finalizer holds each until the
// lines said in it are read (recording-finalize.mjs), the export cuts to them
// (replay-export.mjs), and a walk sends that cut
// (activity-runner/walk-recording.mjs).

import { onFrameGrid } from "./browser-recording.mjs";
import { readingHold } from "./smart-pacing.mjs";

/** How far a Journey's span reaches past its marks, so its first step and its last checkpoint are seen whole. */
const MARK_PAD_MS = 1_000;

/**
 * The marked Journeys as the spans the replay keeps. Each reaches past its
 * marks by MARK_PAD_MS, or by half the gap to its neighbour, so two spans
 * never overlap; one still open ends where the recording does (`endedAt`).
 * A span opens on its Journey's first step: the first of `steps`, in the
 * order they started, from where its reach begins (`reachedAt`) to its end
 * mark. The screen while the agent thought between the mark and that step is
 * cut, and what it said there is placed on the step (openedAt); a step
 * begun beside the mark is kept whole. A span with no step opens where its
 * reach begins.
 * @param {Array<{ title: string, startedAt: number, endedAt: number | null }>} marks
 * @param {number} endedAt
 * @param {number[]} steps
 */
export function journeySpans(marks, endedAt, steps) {
  const spans = marks.map((mark) => ({ title: mark.title, startedAt: mark.startedAt, endedAt: mark.endedAt ?? endedAt }));
  const reach = (gapMs) => Math.min(MARK_PAD_MS, gapMs / 2);
  return spans.map((span, index) => {
    const reachedAt = span.startedAt - (index > 0 ? reach(span.startedAt - spans[index - 1].endedAt) : MARK_PAD_MS);
    return {
      title: span.title,
      reachedAt,
      startedAt: steps.find((at) => at >= reachedAt && at < span.endedAt) ?? reachedAt,
      endedAt: span.endedAt + (index + 1 < spans.length ? reach(spans[index + 1].startedAt - span.endedAt) : MARK_PAD_MS),
    };
  });
}

/**
 * A walk's Journeys placed on the video, every edge on the frame grid the
 * replay is cut on (browser-recording.mjs onFrameGrid), so the cut, the
 * chapters and the opening lines all start on the same frame: none for a walk
 * that marked none. Each span is snapped outward, its start to the frame
 * before and its end to the frame after, so it keeps every frame it touches:
 * the first step, and a line or pointer just before it, are never cut.
 * @param {import("./recording-capture.mjs").Recording} recording its marks, steps and end
 * @param {(epochMs: number) => number} clock the recording's clock
 * @param {number} durationMs the video's length
 */
export function placedJourneys({ marks, steps, endedAt }, clock, durationMs) {
  const spans = journeySpans(marks, endedAt, steps);
  return spans.map((span) => ({
    title: span.title,
    reachedAt: span.reachedAt,
    startedAt: span.startedAt,
    startMs: onFrameGrid(clock(span.startedAt), durationMs, Math.floor),
    endMs: onFrameGrid(clock(span.endedAt), durationMs, Math.ceil),
  }));
}

/**
 * Where a narration line or a move of the agent's attention is placed on the
 * video. One from where a Journey's reach begins up to its first step is
 * placed on the frame the Journey opens on: a line said after the walk marked
 * it (what it set out to prove) would fall in the stretch the cut drops, and
 * the first step's own move would wait for the frame after, leaving the
 * Journey's first frame on the surface before it. Lines that land on one
 * instant there take turns (recording-playback.mjs), and of the moves the
 * step's, the last, decides the surface. Everything else keeps its moment.
 * The whole walk's replay reads the same document, so it opens there too.
 * @param {number} epochMs when it happened
 * @param {ReturnType<typeof placedJourneys>} journeys
 * @param {(epochMs: number) => number} clock the recording's clock
 */
export function openedAt(epochMs, journeys, clock) {
  const opened = journeys.find((journey) => epochMs >= journey.reachedAt && epochMs <= journey.startedAt);
  return opened ? opened.startMs : clock(epochMs);
}

/**
 * The placed Journeys as the replay keeps them: each span's end moved past the
 * reading hold of every line said inside it (smart-pacing.mjs readingHold, the
 * rule that holds the picture while a line is read), so a cut never ends on a
 * line the viewer has not finished. A walk often says how a Journey ended just
 * before it marks the end. The end stays on the frame grid, within the
 * recording, and short of the next span's start.
 * @param {ReadonlyArray<{ title: string, startMs: number, endMs: number }>} journeys placed, in order
 * @param {ReadonlyArray<{ startMs: number, endMs: number, caption: string }>} cues the document's lines, as smart pacing reads them
 * @param {number} durationMs the video's length
 * @returns {Array<{ title: string, startMs: number, endMs: number }>}
 */
export function heldJourneys(journeys, cues, durationMs) {
  return journeys.map(({ title, startMs, endMs }, index) => {
    const said = cues.filter((cue) => cue.startMs >= startMs && cue.startMs < endMs);
    const held = onFrameGrid(Math.max(endMs, ...said.map((cue) => readingHold(cue).endMs)), durationMs, Math.ceil);
    return { title, startMs, endMs: Math.min(held, journeys[index + 1]?.startMs ?? durationMs) };
  });
}
