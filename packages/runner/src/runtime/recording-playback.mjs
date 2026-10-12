// The playback document a finished recording ships with: the one timeline
// the console's player, the replayed console and the exported replay read.
// Narration captions, pointers and the attention track are placed on the
// video here, next to the walk chapters and the fallback narration; the
// geometry and the encoder lines live in browser-recording.mjs, smart pacing
// in smart-pacing.mjs.
import {
  MAX_RECORDING_CAPTION_LENGTH,
  MAX_RECORDING_ATTENTION_POINTS,
  MAX_RECORDING_CHAPTER_LENGTH,
  MAX_RECORDING_CUES,
  MAX_RECORDING_POINTERS,
  MAX_RECORDING_TERMINAL_SESSIONS,
  MAX_RECORDING_TRACK_TEXT_LENGTH,
} from "@shipbash/contracts/runtime/recording-bounds.mjs";
import { recordingClock } from "@shipbash/contracts/runtime/recording-clock.mjs";

import { BROWSER_RECORDING_HEIGHT, BROWSER_RECORDING_WIDTH } from "./browser-recording.mjs";
import { attentionTimeline, shownAttention, terminalSessionTrack } from "./recording-attention.mjs";
import { openedAt, placedJourneys } from "./recording-journeys.mjs";
import { applyWalkChapters, walkSpans, withinWalkShares, withWalkCues } from "./recording-walks.mjs";
import { maskTerminalText } from "./terminal-text-masking.mjs";

const RESULT_CHAPTER = Object.freeze({ chapterId: "summary", chapterTitle: "Result" });
const JOURNEY_OPENING = Object.freeze({
  caption: "I’m opening the product to begin this test.", chapterId: "test", chapterTitle: "Test execution",
});

/**
 * The words a recording opens and closes on when its narration leaves room
 * (addFallbackCues), one entry per kind of recording: a walk's, and a
 * Journey's by how it ended. The closing caption opens the result's chapter.
 */
export const FALLBACK_NARRATION = Object.freeze({
  walk: Object.freeze({
    opening: Object.freeze({ caption: "I’m opening the product to begin this walk.", chapterId: "walk", chapterTitle: "Walk" }),
    closing: Object.freeze({ caption: "This is where the walk ended.", ...RESULT_CHAPTER }),
  }),
  passedJourney: Object.freeze({
    opening: JOURNEY_OPENING,
    closing: Object.freeze({ caption: "I’ve completed the test and verified the expected result.", ...RESULT_CHAPTER }),
  }),
  journey: Object.freeze({
    opening: JOURNEY_OPENING,
    closing: Object.freeze({ caption: "I’ve completed the test and recorded the observed result.", ...RESULT_CHAPTER }),
  }),
});

/**
 * The segments the video joins, each placed where it starts on the
 * timeline, and the anchors the document keeps: where each starts, how long
 * it lasts, and the epoch of its first frame. The anchors are all or nothing:
 * a segment that never painted leaves the recording without a clock, rather
 * than letting the segment before it stretch over its stretch of the video. A
 * segment the join cut off entirely is not on the video, and anchors nothing.
 * @param {ProbedSegment[]} segments in the order the video joins them
 * @param {number} durationMs the joined video's length
 */
function placedSegments(segments, durationMs) {
  let startMs = 0;
  const placed = segments.map((segment) => {
    const at = { ...segment, startMs };
    startMs += segment.durationMs;
    return at;
  });
  if (placed.some((segment) => segment.startedAtEpochMs === null)) return { placed, anchors: [] };
  const anchors = placed.filter((segment) => segment.startMs < durationMs)
    .map((segment) => ({ startMs: segment.startMs, durationMs: segment.durationMs, startedAt: segment.startedAtEpochMs }));
  return { placed, anchors };
}

/** The agent's own narration, placed on the timeline (`at`, recording-journeys.mjs openedAt) and de-duplicated. */
function narrationCues(narrationEvents, at) {
  return narrationEvents.map(({ caption, chapterId, chapterTitle, epochMs, sequence }) => ({
    startMs: at(epochMs), caption, chapterId, chapterTitle, sequence,
  })).sort((left, right) => left.startMs - right.startMs || left.sequence - right.sequence)
    .filter((cue, index, all) => (
      index === 0 || cue.caption !== all[index - 1].caption || cue.startMs - all[index - 1].startMs > 750
    ));
}
/** Opens and closes the recording with the round's own words when there is room. */
function addFallbackCues(cues, { opening, closing }, durationMs) {
  if ((cues[0]?.startMs ?? Number.POSITIVE_INFINITY) > 1_500) {
    cues.unshift({ ...opening, startMs: 0, sequence: -1 });
  }
  if (durationMs > 1_000 && cues.at(-1)?.caption !== closing.caption) {
    const startMs = Math.max(cues.at(-1)?.startMs + 1_000 || 0, durationMs - 5_000);
    if (startMs < durationMs) cues.push({ ...closing, startMs, sequence: Number.MAX_SAFE_INTEGER });
  }
}

/**
 * Cues that land on one instant take turns, in the order they were said,
 * each up to 2.5 s before the next. What is
 * said before a segment's first frame is placed at that frame, beside the
 * walk's divider; left there, each would end where the next begins, unseen.
 */
function spreadSharedStarts(timedCues, durationMs) {
  for (let first = 0, next = 1; first < timedCues.length; first = next, next = first + 1) {
    const { startMs } = timedCues[first];
    while (timedCues[next]?.startMs === startMs) next += 1;
    const roomMs = Math.min(timedCues[next]?.startMs ?? durationMs, durationMs) - startMs;
    const stepMs = Math.min(2_500, Math.floor(roomMs / (next - first)));
    for (let index = first + 1; index < next; index += 1) timedCues[index].startMs = startMs + (index - first) * stepMs;
  }
}

/** Pulls a cue that lands as the recording stops back to where it can be read. */
function spaceFinalCue(timedCues, durationMs) {
  const finalCue = timedCues.at(-1);
  if (finalCue && durationMs - finalCue.startMs < 1_000) {
    const previousCue = timedCues.at(-2);
    finalCue.startMs = Math.max(
      previousCue ? previousCue.startMs + 1_000 : 0,
      durationMs - 5_000,
    );
  }
}

/** Each cue's on-screen window: never past the next cue or the recording's end. */
function boundedCues(timedCues, durationMs) {
  return timedCues.flatMap((cue, index, all) => {
    const nextStart = all[index + 1]?.startMs ?? durationMs;
    const endMs = Math.min(durationMs, cue.startMs + 8_000, nextStart);
    return endMs > cue.startMs ? [{
      startMs: cue.startMs,
      endMs,
      caption: cue.caption,
      chapterId: cue.chapterId,
      chapterTitle: cue.chapterTitle,
    }] : [];
  });
}

/** A coordinate as its fraction of the viewport, to four places. */
function fraction(value, size) {
  return Math.min(1, Math.max(0, Math.round((value / size) * 10_000) / 10_000));
}

/** The Agent's actions as fractions of the viewport, placed by the clock, in recording order. */
function pointerTimeline(pointerEvents, clock) {
  return pointerEvents.map((event) => ({
    atMs: clock(event.epochMs),
    x: fraction(event.x, BROWSER_RECORDING_WIDTH),
    y: fraction(event.y, BROWSER_RECORDING_HEIGHT),
    action: event.action,
  })).sort((left, right) => left.atMs - right.atMs);
}

/** @typedef {import("./recording-capture.mjs").RecordedSegment & { durationMs: number }} ProbedSegment */
/** The playback document as the finalizer leaves it, its idle stretches found. @typedef {Awaited<ReturnType<typeof maskPlaybackText>>} Playback */
/** The document before its words are masked. @typedef {ReturnType<typeof buildRecordingPlaybackMetadata>["playback"]} BuiltPlayback */

/**
 * The playback document of a captured recording whose segments the finalizer
 * probed (each with its video's own length): every moment placed on the
 * joined video, the walks taken over as chapters, the fallback narration
 * (`fallback`, a FALLBACK_NARRATION entry) where there is room, and the
 * attention track as the replay shows it (`terminalLogs`, the shells that can
 * be drawn); beside it, the Journeys a walk marked, placed on the video
 * (recording-journeys.mjs: none for a recording with no clock, which cannot
 * place them), and the walks' spans, which share the idle stretches' bound
 * the finalizer applies once it has found them.
 * @param {import("./recording-capture.mjs").Recording & { segments: ProbedSegment[] }} recording
 * @param {{ fallback: { opening: { caption: string, chapterId: string, chapterTitle: string }, closing: { caption: string, chapterId: string, chapterTitle: string } }, terminalLogs: Record<string, string>, durationMs: number }} assembly
 */
export function buildRecordingPlaybackMetadata(recording, { fallback, terminalLogs, durationMs }) {
  const { segments, narrationEvents, pointerEvents, attention, terminalSessions } = recording;
  const { placed: placedOnVideo, anchors } = placedSegments(segments, durationMs);
  const clock = recordingClock(anchors, durationMs);
  const journeys = clock ? placedJourneys(recording, clock, durationMs) : [];
  // Every captured moment is an epoch, and only the clock places one: a
  // recording without a clock keeps its walk dividers and fallback captions.
  const placed = clock
    ? {
      cues: narrationCues(narrationEvents, (epochMs) => openedAt(epochMs, journeys, clock)),
      pointers: pointerTimeline(pointerEvents, clock),
      attention: shownAttention(attentionTimeline(attention, (epochMs) => openedAt(epochMs, journeys, clock)), terminalLogs),
    }
    : { cues: [], pointers: [], attention: [] };
  const spans = walkSpans(placedOnVideo, durationMs);
  const cues = withWalkCues(placed.cues, spans);
  // The first walk cue sits at offset 0, which is where the fallback opening
  // would have gone, so the opening stands down of its own accord.
  addFallbackCues(cues, fallback, durationMs);
  // Each bound is the document's, shared between its walks.
  const timedCues = withinWalkShares(cues, spans, (cue) => cue.startMs, MAX_RECORDING_CUES);
  spreadSharedStarts(timedCues, durationMs);
  spaceFinalCue(timedCues, durationMs);
  // Last, once every cue is on its final millisecond: the walks take the
  // chapters over, closing narration included.
  applyWalkChapters(timedCues, spans);
  const shells = terminalSessionTrack(terminalSessions, attention);
  const playback = {
    schemaVersion: 4,
    anchors,
    cues: boundedCues(timedCues, durationMs),
    speedSegments: [],
    pointers: withinWalkShares(placed.pointers, spans, (pointer) => pointer.atMs, MAX_RECORDING_POINTERS),
    attention: withinWalkShares(placed.attention, spans, (point) => point.atMs, MAX_RECORDING_ATTENTION_POINTS),
    terminal: clock
      ? withinWalkShares(shells, spans, (shell) => clock(shell.startedAt), MAX_RECORDING_TERMINAL_SESSIONS)
      : shells.slice(0, MAX_RECORDING_TERMINAL_SESSIONS),
  };
  return {
    playback,
    journeys: journeys.map(({ title, startMs, endMs }) => ({ title, startMs, endMs })),
    walks: spans,
  };
}

/**
 * The document's words — each caption, chapter title and shell label — masked
 * as a shell's recording is (terminal-text-masking.mjs), with every secret the
 * runner registered by the time the walk ended, and only then cut to the
 * document's bounds. The builder leaves them whole for this: a secret is
 * found before any cut can split it, and what replaces a secret can never
 * carry a word past the bound the parser would drop the whole document for.
 * The operator's page and a share link read these same words, so this is the
 * one place they are masked; `masked` says it was done. Each word is whole,
 * and a caption is not drawn in the pty, so no row width applies to it.
 * @param {BuiltPlayback} playback
 * @param {{ redactor: Parameters<typeof maskTerminalText>[1]["redactor"], scan?: Parameters<typeof maskTerminalText>[1]["scan"] }} masking
 */
export async function maskPlaybackText(playback, { redactor, scan }) {
  const masked = new Map();
  const words = async (text, limit) => {
    if (!masked.has(text)) {
      masked.set(text, maskTerminalText(text, { redactor, scan, columns: Number.POSITIVE_INFINITY, sessionEnds: false }));
    }
    return (await masked.get(text)).slice(0, limit).trim();
  };
  return {
    ...playback,
    cues: await Promise.all(playback.cues.map(async (cue) => ({
      ...cue, caption: await words(cue.caption, MAX_RECORDING_CAPTION_LENGTH), chapterTitle: await words(cue.chapterTitle, MAX_RECORDING_CHAPTER_LENGTH),
    }))),
    attention: await Promise.all(playback.attention.map(async (point) => ({
      ...point, label: point.label === null ? null : await words(point.label, MAX_RECORDING_TRACK_TEXT_LENGTH),
    }))),
    terminal: await Promise.all(playback.terminal.map(async (session) => ({
      ...session, label: await words(session.label, MAX_RECORDING_TRACK_TEXT_LENGTH),
    }))),
    masked: true,
  };
}
