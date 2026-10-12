// The overlay a recording carries when it leaves the console.
//
// A recording posted where there is no player — a Slack thread, a download —
// has nothing to draw its chapters, the agent's points or its narration, so
// the exported video carries them burned in over the picture: the piece of
// narration on screen as a subtitle, and under it, on a shade at the frame's
// foot, a narrow band — the chapter's counter, its title, the time — resting
// on a thin bar at the frame's bottom edge. This module is the one description
// of that overlay: the design (recording-overlay-spec.mjs), how narration is
// cut into pieces (recording-overlay-captions.mjs), where every run of text
// and every shape sits and what of it fits (recording-overlay-layout.mjs),
// and, here, what the overlay shows at any moment of a recording. The console's Storybook preview draws it as
// HTML and the runner's exporter as ASS subtitles for libass, and neither
// decides anything this module does not.
//
// A leaf like attention-track.mjs, whose track it reads: the console's
// bundles and the runner both import it, and neither may pull anything else
// in through it.

import { attentionSegments } from "./attention-track.mjs";
import { captionPieces, normalizeOverlayText } from "./recording-overlay-captions.mjs";
import { bandHoldsTitle } from "./recording-overlay-layout.mjs";
import { RECORDING_OVERLAY } from "./recording-overlay-spec.mjs";

export { RECORDING_OVERLAY };
export { captionPieces } from "./recording-overlay-captions.mjs";
export {
  GRID_ROOM, PICTURE_ROOM, SHADE_LAYOUT, bandLayout, barLayout, captionLayout, pictureLayout, textWidth,
} from "./recording-overlay-layout.mjs";

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function twoDigits(value) {
  return String(value).padStart(2, "0");
}

/** A chapter's counter: "06/07". */
function counterText(index, count) {
  return `${twoDigits(index + 1)}/${twoDigits(count)}`;
}

/**
 * Where a chapter's title card ends. A chapter whose title the band would cut
 * opens on the whole title in the subtitle's box for as long as it takes to
 * read, `card.charMs` a character and never less than a caption piece's
 * minimum; one whose title the band holds has no card, which ends where the
 * chapter starts.
 */
function cardEndMs(chapter) {
  const { caption, card } = RECORDING_OVERLAY;
  const text = normalizeOverlayText(chapter.title);
  if (bandHoldsTitle(text)) return chapter.startMs;
  return chapter.startMs + Math.max(caption.minPieceMs, [...text].length * card.charMs);
}

/**
 * Where each chapter's title card ends, in chapter order: the moments the
 * subtitle's box goes back to the narration.
 * @param {{ chapters: ReadonlyArray<{ title: string, startMs: number }> }} recording
 */
export function titleCardEnds(recording) {
  return recording.chapters.map((chapter) => cardEndMs(chapter));
}

/**
 * The narration as the subtitle shows it. A line said while a chapter is on its
 * title card waits for the card to end, and a line that would then start
 * before the one held back ahead of it has finished waits for that one too;
 * each keeps its own length. Every other line keeps its moment.
 * @param {{ chapters: ReadonlyArray<{ title: string, startMs: number }>, cues: ReadonlyArray<{ startMs: number, endMs: number, caption: string }> }} recording
 */
export function shownCues(recording) {
  const ends = titleCardEnds(recording);
  const cardEnd = (atMs) => ends.find((endMs, index) => atMs >= recording.chapters[index].startMs && atMs < endMs);
  let heldUntil = Number.NEGATIVE_INFINITY;
  return recording.cues.map((cue) => {
    const startMs = Math.max(cardEnd(cue.startMs) ?? cue.startMs, heldUntil);
    const shown = { ...cue, startMs, endMs: cue.endMs + startMs - cue.startMs };
    heldUntil = startMs > cue.startMs ? shown.endMs : Number.NEGATIVE_INFINITY;
    return shown;
  });
}

/** A moment of the recording as the band's clock reads it: mm:ss. */
function clockTime(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  return `${twoDigits(Math.floor(seconds / 60))}:${twoDigits(seconds % 60)}`;
}

/**
 * The stretches the bar is cut into: one per chapter, with whatever comes
 * before the first chapter as a lead-in of its own, and the whole recording
 * as one stretch when it has no chapters at all.
 */
function barSpans(recording) {
  const { chapters, durationMs } = recording;
  const first = chapters[0];
  if (first === undefined) return { spans: [{ id: "recording", startMs: 0, endMs: durationMs }], leadIn: 1 };
  if (first.startMs <= 0) return { spans: chapters, leadIn: 0 };
  return { spans: [{ id: "lead-in", startMs: 0, endMs: first.startMs }, ...chapters], leadIn: 1 };
}

/**
 * The one answer to which stretch a moment belongs to: the stretch it falls
 * in, from the recording's end on — where no stretch reaches — the last, and
 * -1 in a gap between two chapters, where none is playing.
 */
function spanAt(spans, atMs) {
  const found = spans.findIndex((span) => atMs >= span.startMs && atMs < span.endMs);
  return found === -1 && atMs >= (spans.at(-1)?.endMs ?? 0) ? spans.length - 1 : found;
}

/** The agent's actions and every switch to a shell, the two points the bar marks, in time order. */
function pointTimes(recording) {
  const terminals = attentionSegments(recording.attention, recording.durationMs)
    .filter((segment) => segment.surface === "terminal")
    .map((segment) => segment.startMs);
  return [...recording.pointers.map((pointer) => pointer.atMs), ...terminals].sort((left, right) => left - right);
}

/** The piece of narration on screen: the cue whose window holds the moment, cut into its timed pieces. */
function captionAt(cues, atMs) {
  let cue = null;
  for (const candidate of cues) if (candidate.startMs <= atMs) cue = candidate;
  if (cue === null || atMs >= cue.endMs) return null;
  const pieces = captionPieces(cue);
  return (pieces.find((piece) => atMs < piece.endMs) ?? pieces.at(-1))?.text ?? null;
}

/**
 * What the overlay shows at `timeMs`: the chapter playing, its counter and
 * title, whether the chapter is still on its title card (`card`), the piece
 * of narration (shownCues, none on a card), the clock, the bar's stretches
 * (where each starts and ends — in milliseconds, and as fractions of the
 * recording — how much of it has played, which one is playing) and the
 * points, as fractions of the recording.
 * @param {{ durationMs: number, chapters: ReadonlyArray<{ id: string, title: string, startMs: number, endMs: number }>, cues: ReadonlyArray<{ startMs: number, endMs: number, caption: string }>, pointers: ReadonlyArray<{ atMs: number }>, attention: ReadonlyArray<{ atMs: number, surface: "browser" | "terminal" }> }} recording
 * @param {number} timeMs
 */
export function overlayFrame(recording, timeMs) {
  const durationMs = Math.max(1, recording.durationMs);
  const atMs = clamp(timeMs, 0, recording.durationMs);
  const { spans, leadIn } = barSpans(recording);
  const playing = spanAt(spans, atMs);
  const chapterIndex = playing - leadIn;
  const chapter = recording.chapters[chapterIndex];
  const counter = chapter ? counterText(chapterIndex, recording.chapters.length) : null;
  const card = chapter !== undefined && atMs < cardEndMs(chapter);
  return {
    timeMs: atMs,
    chapter: chapter ? { id: chapter.id, index: chapterIndex + 1, count: recording.chapters.length } : null,
    counter,
    title: chapter ? normalizeOverlayText(chapter.title) : null,
    card,
    caption: card ? null : captionAt(shownCues(recording), atMs),
    time: `${clockTime(atMs)} / ${clockTime(recording.durationMs)}`,
    segments: spans.map((span, index) => ({
      id: span.id,
      startMs: span.startMs,
      endMs: span.endMs,
      start: span.startMs / durationMs,
      end: span.endMs / durationMs,
      played: clamp((atMs - span.startMs) / Math.max(1, span.endMs - span.startMs), 0, 1),
      current: index === playing,
    })),
    points: pointTimes(recording).map((pointMs) => ({
      at: clamp(pointMs / durationMs, 0, 1),
      current: playing !== -1 && spanAt(spans, clamp(pointMs, 0, recording.durationMs)) === playing,
    })),
  };
}
