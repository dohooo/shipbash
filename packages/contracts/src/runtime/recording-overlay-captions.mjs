// A narration line cut into pieces the overlay's subtitle shows one after
// another. Read through recording-overlay.mjs.
//
// Where to cut, in order of preference: between sentences, then between
// clauses (after a comma, semicolon, colon or dash, before "and" or "but"),
// and only as a last resort between two words. A word is never cut.

import { RECORDING_OVERLAY } from "./recording-overlay-spec.mjs";

/**
 * One emoji as drawn in colour: a keycap, a character whose default is the
 * emoji presentation, or any emoji character asked for it with U+FE0F, with
 * its skin tone, selectors and tag letters.
 */
const EMOJI_UNIT = String.raw`(?:[0-9#*]\u{FE0F}?\u{20E3}|\p{Emoji_Presentation}|\p{Emoji}\u{FE0F})(?:\p{Emoji_Modifier}|\u{FE0F}|[\u{E0020}-\u{E007F}])*`;

/**
 * Emoji drawn in colour, joined sequences whole, with the space before them
 * so no gap is left before the punctuation that follows. libass cannot draw
 * them, so the preview leaves them out too. Characters that are text by
 * default — ©, ®, ™, arrows — are drawn as text by both, and stay.
 */
const EMOJI = new RegExp(`\\s*${EMOJI_UNIT}(?:\\u{200D}${EMOJI_UNIT})*`, "gu");

/** Text as the overlay draws it: composed (NFC), no colour emoji, and one space between words. */
export function normalizeOverlayText(text) {
  return String(text ?? "").normalize("NFC").replace(EMOJI, "").replace(/\s+/gu, " ").trim();
}

/**
 * What a cut costs on top of the space it leaves unused. A cut between words
 * costs more than any two clause-aligned pieces could save by being even.
 */
const CUT_COST = Object.freeze({ sentence: 0, clause: 300, word: 5_000 });
const CONJUNCTIONS = new Set(["and", "but"]);
const SENTENCE_END = /[.!?…]["'”’)]*$/u;
const SENTENCE_START = /^["'“‘(]*[A-Z0-9]/u;
const CLAUSE_END = /[,;:—–]["'”’)]*$/u;
const DASH = /^[—–-]$/u;

/** What kind of cut falls between `word` and the `next` one. */
function boundaryBetween(word, next) {
  if (SENTENCE_END.test(word) && SENTENCE_START.test(next)) return "sentence";
  if (CLAUSE_END.test(word) || DASH.test(word)) return "clause";
  return CONJUNCTIONS.has(next.toLowerCase()) ? "clause" : "word";
}

/** The sentences of a line, each as its words. */
function sentences(words) {
  const found = [[]];
  words.forEach((word, index) => {
    found[found.length - 1].push(word);
    const next = words[index + 1];
    if (next !== undefined && boundaryBetween(word, next) === "sentence") found.push([]);
  });
  return found;
}

/** What starting a piece at `start` costs: nothing at the sentence's own start. */
function cutCost(words, start) {
  return start > 0 ? CUT_COST[boundaryBetween(words[start - 1], words[start])] : 0;
}

/** The pieces the cheapest cuts make, read back from where each piece starts. */
function piecesFrom(words, from) {
  const pieces = [];
  for (let end = words.length; end > 0; end = from[end]) pieces.unshift(words.slice(from[end], end).join(" "));
  return pieces;
}

/**
 * One sentence cut into the pieces that leave the least space unused, summed
 * as squares so the pieces come out even, plus what each cut costs.
 */
function cutSentence(words, maxChars) {
  const best = [0];
  const from = [0];
  for (let end = 1; end <= words.length; end += 1) {
    best[end] = Number.POSITIVE_INFINITY;
    let length = -1;
    for (let start = end - 1; start >= 0; start -= 1) {
      length += words[start].length + 1;
      if (length > maxChars && end - start > 1) break;
      const cost = best[start] + Math.max(0, maxChars - length) ** 2 + cutCost(words, start);
      if (cost < best[end]) {
        best[end] = cost;
        from[end] = start;
      }
    }
  }
  return piecesFrom(words, from);
}

/** Joins neighbouring pieces while the joined piece still fits. */
function packPieces(pieces, maxChars) {
  const packed = [];
  for (const piece of pieces) {
    const last = packed.at(-1);
    if (last !== undefined && last.length + 1 + piece.length <= maxChars) packed[packed.length - 1] = `${last} ${piece}`;
    else packed.push(piece);
  }
  return packed;
}

/**
 * The pieces of one narration line, in reading order, each no longer than
 * `caption.maxChars`, which the subtitle's box holds. Joined with spaces they
 * give back the line as normalizeOverlayText reads it.
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string[]}
 */
export function splitCaption(text, maxChars = RECORDING_OVERLAY.caption.maxChars) {
  const whole = normalizeOverlayText(text);
  if (whole === "") return [];
  if (whole.length <= maxChars) return [whole];
  const cut = sentences(whole.split(" ")).flatMap((sentence) => (
    sentence.join(" ").length <= maxChars ? [sentence.join(" ")] : cutSentence(sentence, maxChars)
  ));
  return packPieces(cut, maxChars);
}

/**
 * How long the subtitle needs to show a narration line whole: each of its
 * pieces for a piece's minimum.
 * @param {string} text
 */
export function captionReadingMs(text) {
  return splitCaption(text).length * RECORDING_OVERLAY.caption.minPieceMs;
}

/**
 * Joins the two neighbours that are shortest together until every piece can
 * have its minimum time. A joined piece may not fit the box; the layout cuts
 * it with an ellipsis, the lesser harm next to a piece shown too briefly to read.
 */
function mergeToFit(pieces, spanMs, minPieceMs) {
  const fitting = Math.max(1, Math.floor(spanMs / minPieceMs));
  const merged = [...pieces];
  while (merged.length > fitting) {
    let at = 0;
    for (let index = 1; index < merged.length - 1; index += 1) {
      if (merged[index].length + merged[index + 1].length < merged[at].length + merged[at + 1].length) at = index;
    }
    merged.splice(at, 2, `${merged[at]} ${merged[at + 1]}`);
  }
  return merged;
}

/**
 * A cue's line as timed pieces that tile its span exactly: each piece gets
 * the minimum time, and what is left is shared in proportion to length.
 * @param {{ startMs: number, endMs: number, caption: string }} cue
 * @param {{ maxChars?: number, minPieceMs?: number }} [options]
 * @returns {Array<{ startMs: number, endMs: number, text: string }>}
 */
export function captionPieces(cue, options = {}) {
  const { maxChars = RECORDING_OVERLAY.caption.maxChars, minPieceMs = RECORDING_OVERLAY.caption.minPieceMs } = options;
  const spanMs = Math.max(0, cue.endMs - cue.startMs);
  const pieces = mergeToFit(splitCaption(cue.caption, maxChars), spanMs, minPieceMs);
  const totalChars = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const floorMs = pieces.length * minPieceMs <= spanMs ? minPieceMs : 0;
  const spareMs = spanMs - floorMs * pieces.length;
  let startMs = cue.startMs;
  let charsBefore = 0;
  return pieces.map((text, index) => {
    charsBefore += text.length;
    const endMs = index === pieces.length - 1
      ? cue.endMs
      : cue.startMs + floorMs * (index + 1) + Math.round((spareMs * charsBefore) / Math.max(1, totalChars));
    const piece = { startMs, endMs, text };
    startMs = endMs;
    return piece;
  });
}
