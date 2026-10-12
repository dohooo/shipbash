// A recording's timeline as its viewers read it: the chapters its narration
// names, and the paced time smart pacing plays it on.
//
// The console's player plays each idle stretch the finalizer detected at its
// playbackRate and everything else at 1x; the exported replay is encoded on
// the same paced timeline, so the burned-in overlay, the player and the video
// agree on where every moment falls. Both read the rate and the mapping from
// here, as they read the chapters.
//
// A zero-dependency leaf like recording-clock.mjs: the console's bundles and
// the runner both import it.

/**
 * The chapters a recording's narration names: one per run of cues that share
 * a chapter id, each lasting until the next begins, the last until the end.
 * @param {ReadonlyArray<{ startMs: number, chapterId: string, chapterTitle: string }>} cues
 * @param {number} durationMs
 */
export function deriveBrowserRecordingChapters(cues, durationMs) {
  const chapters = [];
  for (const cue of cues) {
    if (chapters.at(-1)?.id === cue.chapterId) continue;
    chapters.push({ id: cue.chapterId, title: cue.chapterTitle, startMs: cue.startMs });
  }
  return chapters.map((chapter, index) => ({
    ...chapter,
    endMs: chapters[index + 1]?.startMs ?? durationMs,
  })).filter((chapter) => chapter.endMs > chapter.startMs);
}

/**
 * The rate a moment of the recording plays at under smart pacing: its idle
 * stretch's playbackRate (the playback document holds whole rates from 2x),
 * and 1x outside every stretch.
 * @param {ReadonlyArray<{ startMs: number, endMs: number, playbackRate: number }> | undefined} segments
 * @param {number} atMs
 */
export function pacedRate(segments, atMs) {
  return segments?.find((candidate) => atMs >= candidate.startMs && atMs < candidate.endMs)?.playbackRate ?? 1;
}

/**
 * The recording cut where its rate changes, each stretch with the rate it
 * plays at and where it starts and ends on the paced timeline. The stretches
 * tile [0, durationMs) in order.
 * @param {ReadonlyArray<{ startMs: number, endMs: number, playbackRate: number }>} segments
 * @param {number} durationMs
 */
export function pacedTimeline(segments, durationMs) {
  const cuts = new Set([0, durationMs]);
  for (const segment of segments) {
    for (const at of [segment.startMs, segment.endMs]) if (at > 0 && at < durationMs) cuts.add(at);
  }
  const edges = [...cuts].sort((left, right) => left - right);
  const pieces = [];
  let outMs = 0;
  for (let index = 0; index < edges.length - 1; index += 1) {
    const [startMs, endMs] = [edges[index], edges[index + 1]];
    const rate = pacedRate(segments, startMs);
    const outEndMs = outMs + (endMs - startMs) / rate;
    pieces.push({ startMs, endMs, rate, outStartMs: outMs, outEndMs });
    outMs = outEndMs;
  }
  return pieces;
}

/**
 * Where a moment of the recording falls on the paced timeline. A moment past
 * the last stretch keeps the last stretch's rate.
 * @param {ReadonlyArray<{ startMs: number, endMs: number, rate: number, outStartMs: number, outEndMs: number }>} timeline
 * @param {number} atMs
 */
export function pacedTime(timeline, atMs) {
  const piece = timeline.find((candidate) => atMs < candidate.endMs) ?? timeline.at(-1);
  if (piece === undefined) return Math.max(0, atMs);
  return piece.outStartMs + (Math.max(piece.startMs, atMs) - piece.startMs) / piece.rate;
}
