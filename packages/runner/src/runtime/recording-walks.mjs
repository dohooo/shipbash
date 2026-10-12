// The chapters of a recording that holds more than one walk.
//
// A journey that fails is walked again at once to confirm the failure, and
// both walks are concatenated into the one video the case run owns. Nothing
// in the picture marks the seam: the viewer of a 378-second "failed, then
// passed" recording sees one continuous take. So the walks become the
// recording's chapters — every cue inside a walk names that walk, whatever
// the agent called its own chapter, and the chapter list the player draws is
// exactly "Walk 1 · failed", "Walk 2 · passed".
//
// Taking the chapters over is the point. A walk marker left among the agent's
// own chapters gives the reader six dividers and two "Result"s and never says
// which walk they are in; two dividers say it and nothing else has to.
//
// One walk means no seam to mark, so a recording with a single walk gets no
// spans and reads exactly as it did before.

/**
 * The word the chapter title ends on. Every outcome the case contract allows
 * — passed, failed, blocked, error, auth_required — is its own word; a walk
 * that never reached a result was cut short, which cancellation is the only
 * way to do.
 */
function outcomeWord(outcome) {
  return typeof outcome === "string" && /^[a-z][a-z_]{0,30}$/u.test(outcome)
    ? outcome.replaceAll("_", " ")
    : "canceled";
}

/** Each walk's reach on the assembled timeline, widened by its own segments. */
function placedWalks(segments, durationMs) {
  const placed = [];
  for (const segment of segments) {
    if (segment.startMs >= durationMs) continue;
    const existing = placed.find((walk) => walk.walk === segment.walk);
    if (existing) {
      existing.startMs = Math.min(existing.startMs, segment.startMs);
      continue;
    }
    placed.push({ walk: segment.walk, outcome: outcomeWord(segment.outcome), startMs: segment.startMs });
  }
  return placed.sort((left, right) => left.startMs - right.startMs);
}

/**
 * The walks as contiguous spans of the timeline, each named for the chapter
 * it becomes. Nothing under two walks: there is no seam to mark, and the
 * recording keeps the chapters it always had.
 *
 * @param {Array<{ startMs: number, walk: number, outcome: string | null }>} segments the video's segments, placed
 * @param {number} durationMs
 */
export function walkSpans(segments, durationMs) {
  const placed = placedWalks(segments, durationMs);
  if (placed.length < 2) return [];
  return placed.map((walk, index) => {
    const position = index + 1;
    const total = placed.length;
    return {
      chapterId: `walk-${String(position)}`,
      chapterTitle: `Walk ${String(position)} · ${walk.outcome}`,
      caption: position < total
        ? `Walk ${String(position)} of ${String(total)} ended ${walk.outcome}; walking again to confirm.`
        : `Walk ${String(position)} of ${String(total)} ended ${walk.outcome}.`,
      startMs: walk.startMs,
      // Contiguous to the next walk, and the last one runs to the end, so
      // every cue on the timeline falls inside exactly one span.
      endMs: placed[index + 1]?.startMs ?? durationMs,
    };
  });
}

/** The seam's own caption, folded in among the agent's narration in order. */
export function withWalkCues(cues, spans) {
  if (spans.length === 0) return cues;
  const walkCues = spans.map((span) => ({
    startMs: span.startMs,
    caption: span.caption,
    chapterId: span.chapterId,
    chapterTitle: span.chapterTitle,
    sequence: 0,
  }));
  return [...walkCues, ...cues]
    .sort((left, right) => left.startMs - right.startMs || left.sequence - right.sequence);
}

/** Which walk's span holds a moment of the video: the last walk's runs to the end. */
function walkIndexAt(spans, ms) {
  const index = spans.findIndex((span) => ms < span.endMs);
  return index === -1 ? spans.length - 1 : index;
}

/**
 * The walks taken over as the chapters. Captions are the agent's and stay
 * untouched; only which chapter each one belongs to is rewritten, so the
 * player's chapter list is the walks and nothing else.
 */
export function applyWalkChapters(cues, spans) {
  if (spans.length === 0) return;
  for (const cue of cues) {
    const span = spans[walkIndexAt(spans, cue.startMs)];
    cue.chapterId = span.chapterId;
    cue.chapterTitle = span.chapterTitle;
  }
}

/**
 * How many of each walk's items the document keeps under its `bound`: an
 * equal share each, and what a walk leaves of its share goes to the walks
 * that have more, so a re-run never loses its narration, pointers, moves,
 * shells or idle stretches to a first walk that filled the bound alone.
 * @param {number[]} counts each walk's items
 * @param {number} bound
 */
function walkShares(counts, bound) {
  const shares = counts.map(() => 0);
  let left = Math.min(bound, counts.reduce((total, count) => total + count, 0));
  while (left > 0) {
    const open = counts.flatMap((count, index) => (shares[index] < count ? [index] : []));
    const each = Math.max(1, Math.floor(left / open.length));
    for (const index of open) {
      const take = Math.min(each, counts[index] - shares[index], left);
      shares[index] += take;
      left -= take;
    }
  }
  return shares;
}

/**
 * The items the document keeps under its `bound`, in timeline order: with
 * one walk, the earliest; with several (`spans`), each walk's earliest within
 * its share (walkShares), each item counted in the walk whose span holds
 * `timeOf(item)`.
 * @template T
 * @param {T[]} items in timeline order
 * @param {ReturnType<typeof walkSpans>} spans
 * @param {(item: T) => number} timeOf
 * @param {number} bound
 * @returns {T[]}
 */
export function withinWalkShares(items, spans, timeOf, bound) {
  if (spans.length < 2 || items.length <= bound) return items.slice(0, bound);
  const walkOf = (item) => walkIndexAt(spans, timeOf(item));
  const counts = spans.map(() => 0);
  for (const item of items) counts[walkOf(item)] += 1;
  const shares = walkShares(counts, bound);
  return items.filter((item) => {
    const walk = walkOf(item);
    shares[walk] -= 1;
    return shares[walk] >= 0;
  });
}
