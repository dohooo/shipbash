// Where everything on the overlay sits: the shade, each run of text on the
// band and what of it fits, the subtitle's box and its lines, and each
// rectangle of the bar with its final colour. Read through
// recording-overlay.mjs.
//
// Neither renderer lays anything out: the preview positions each run and
// rectangle absolutely and the exporter gives each one a \pos or a drawing,
// both at the coordinates computed here, and both draw the strings cut and
// the lines broken here. Widths come from the faces' own advances
// (recording-overlay-metrics.mjs) with kerning and ligatures off in both
// renderers, so a run measured here is as wide as it is drawn.

import { RECORDING_OVERLAY_METRICS } from "./recording-overlay-metrics.mjs";
import { RECORDING_OVERLAY } from "./recording-overlay-spec.mjs";

/** Characters a fallback font draws a full em wide: CJK and the full-width forms. */
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u{3000}-\u{303F}\u{FF00}-\u{FFEF}]/u;
/** Punctuation that closes what comes before it, so a line never starts with it. */
const CLOSING = /[、。，．：；！？）」』】〉》”’…]/u;
/** What a cut leaves at its end before the ellipsis goes on: no dangling space, comma or dash. */
const CUT_TAIL = /[\s,;:—–-]+$/u;

/**
 * How wide a run of text is, in pixels, in one of the overlay's faces at a
 * size. A character outside the subset is counted as its fallback is drawn:
 * an em when it is wide, `fallbackAdvance` ems otherwise.
 * @param {string} text
 * @param {"medium" | "bold"} face
 * @param {number} size
 */
export function textWidth(text, face, size) {
  const metrics = RECORDING_OVERLAY_METRICS[face];
  let units = 0;
  for (const character of text) {
    const advance = metrics.advances[character.codePointAt(0)];
    if (advance !== undefined) units += advance;
    else units += metrics.unitsPerEm * (WIDE.test(character) ? 1 : RECORDING_OVERLAY.fonts.fallbackAdvance);
  }
  return (units / metrics.unitsPerEm) * size;
}

/** The longest start of `characters` that fits with the ellipsis after it, or null. */
function cutByCharacters(characters, fits) {
  for (let count = characters.length - 1; count > 0; count -= 1) {
    const cut = characters.slice(0, count).join("").replace(CUT_TAIL, "");
    if (cut && fits(cut)) return cut;
  }
  return null;
}

/**
 * The text as it fits `room` pixels, composed (NFC): whole when it fits,
 * otherwise cut after the last whole word that leaves room for the ellipsis
 * — inside the first word only when not even that one fits — and empty when
 * not even the ellipsis does.
 * @param {string} text
 * @param {"medium" | "bold"} face
 * @param {number} size
 * @param {number} room
 */
export function fitText(text, face, size, room) {
  const whole = String(text).normalize("NFC");
  if (textWidth(whole, face, size) <= room) return whole;
  const { ellipsis } = RECORDING_OVERLAY;
  const fits = (cut) => textWidth(`${cut}${ellipsis}`, face, size) <= room;
  const words = whole.split(" ");
  for (let count = words.length - 1; count > 0; count -= 1) {
    const cut = words.slice(0, count).join(" ").replace(CUT_TAIL, "");
    if (cut && fits(cut)) return `${cut}${ellipsis}`;
  }
  const cut = cutByCharacters([...(words[0] ?? "")], fits);
  if (cut) return `${cut}${ellipsis}`;
  return textWidth(ellipsis, face, size) <= room ? ellipsis : "";
}

/** The title's room: the band's width less what the counter and the time each keep at its ends. */
const TITLE_ROOM = (() => {
  const { frame, band } = RECORDING_OVERLAY;
  return frame.width - 2 * (band.paddingX + band.sideWidth + band.gap);
})();

/**
 * Whether the band holds a chapter's title whole. A title it would cut opens
 * its chapter on a title card (overlayFrame).
 * @param {string} titleText
 */
export function bandHoldsTitle(titleText) {
  const { title } = RECORDING_OVERLAY;
  return textWidth(titleText.normalize("NFC"), title.face, title.size) <= TITLE_ROOM;
}

/**
 * Every run on the band, as x positions and the text each one draws: the
 * counter from the left padding, the time against the right one, and the
 * title centred on the frame in the room between them, cut with an ellipsis
 * when it does not fit — on a title card too, while the box shows it whole.
 * `centerY` is the band's middle line, which every run is centred on.
 * @param {{ counter: string | null, title: string | null, time: string }} frame
 */
export function bandLayout(frame) {
  const { band, bar, frame: size, title, time } = RECORDING_OVERLAY;
  const titleText = frame.title === null ? "" : fitText(frame.title, title.face, title.size, TITLE_ROOM);
  return {
    centerY: size.height - bar.height - band.height / 2,
    counter: frame.counter === null ? null : { x: band.paddingX, text: frame.counter },
    title: titleText ? { x: (size.width - textWidth(titleText, title.face, title.size)) / 2, text: titleText } : null,
    time: { x: size.width - band.paddingX - textWidth(frame.time, time.face, time.size), text: frame.time },
  };
}

/** Whether a line may break between `previous` and `character` with no space: around a wide character, never before closing punctuation. */
function breaksBefore(previous, character) {
  return !CLOSING.test(character) && (WIDE.test(previous) || WIDE.test(character));
}

/**
 * A word as the units a line may break between: each wide character on its
 * own, with closing punctuation kept on the one before it; any other run
 * whole, unless it is wider than `room`, which cuts it by characters.
 */
function wordUnits(word, face, size, room) {
  const units = [];
  let previous = "";
  for (const character of word) {
    const last = units.at(-1);
    const joined = `${last ?? ""}${character}`;
    if (last === undefined || breaksBefore(previous, character) || textWidth(joined, face, size) > room) units.push(character);
    else units[units.length - 1] = joined;
    previous = character;
  }
  return units;
}

/** A line's units as one string, each after the space it followed. */
function joinUnits(units) {
  return units.map((unit, index) => (index === 0 ? unit.text : `${unit.joiner}${unit.text}`)).join("");
}

/**
 * The text broken into lines no wider than `room`, filled one after another:
 * between words, and between characters around a wide one, as CJK text
 * breaks. A piece no line could hold is broken by characters. Past `maxLines`
 * the last line takes the rest, cut with the ellipsis.
 */
function wrapLines(text, face, size, room, maxLines) {
  const units = String(text).normalize("NFC").split(" ").filter(Boolean).flatMap((word, index) => (
    wordUnits(word, face, size, room).map((unit, at) => ({ text: unit, joiner: at === 0 && index > 0 ? " " : "" }))
  ));
  const lines = [];
  for (const unit of units) {
    const line = lines.at(-1);
    if (line !== undefined && textWidth(joinUnits([...line, unit]), face, size) <= room) line.push(unit);
    else lines.push([unit]);
  }
  if (lines.length <= maxLines) return lines.map(joinUnits);
  return [...lines.slice(0, maxLines - 1).map(joinUnits), fitText(joinUnits(lines.slice(maxLines - 1).flat()), face, size, room)];
}

/**
 * The subtitle: on a title card the chapter's whole title in the card's
 * style, otherwise the piece of narration on screen in the caption's, broken
 * into the box's lines — or null when neither shows. The box hugs its widest
 * line, is centred on the frame, and stands its gap above the band; each line
 * is centred in it, on its own middle line (`centerY`), as the band's runs
 * are.
 * @param {{ title: string | null, card: boolean, caption: string | null }} frame
 */
export function captionLayout(frame) {
  const { box, caption, frame: size, band, bar } = RECORDING_OVERLAY;
  const style = frame.card ? "card" : "caption";
  const run = RECORDING_OVERLAY[style];
  const text = frame.card ? frame.title : frame.caption;
  if (!text) return null;
  const lines = wrapLines(text, run.face, run.size, box.maxWidth - 2 * box.paddingX, caption.maxLines);
  const widths = lines.map((line) => textWidth(line, run.face, run.size));
  const lineHeight = run.size * caption.lineHeight;
  const width = Math.round(Math.max(...widths) + 2 * box.paddingX);
  const height = Math.round(lines.length * lineHeight + box.paddingTop + box.paddingBottom);
  const top = size.height - bar.height - band.height - box.gap - height;
  return {
    style,
    box: { x: Math.round((size.width - width) / 2), y: top, width, height, radius: box.radius, color: box.color, alpha: box.opacity },
    lines: lines.map((line, index) => ({
      x: (size.width - widths[index]) / 2,
      centerY: top + box.paddingTop + lineHeight * (index + 0.5),
      text: line,
    })),
  };
}

/** The shade's opacity at `at`, from its top (0) to the frame's bottom edge (1), between its stops. */
function shadeOpacity(at) {
  const { stops } = RECORDING_OVERLAY.shade;
  const after = stops.findIndex(([position]) => position >= at);
  if (after === -1) return stops.at(-1)?.[1] ?? 0;
  if (after === 0) return stops[0][1];
  const [[fromAt, from], [toAt, to]] = [stops[after - 1], stops[after]];
  return from + ((to - from) * (at - fromAt)) / (toAt - fromAt);
}

/**
 * The shade over the picture's foot: its rectangle and opacity stops, which
 * the preview draws as a CSS gradient, and the one-pixel strips the stops
 * make, which the exporter draws, as libass has no gradient.
 */
export const SHADE_LAYOUT = (() => {
  const { frame, shade } = RECORDING_OVERLAY;
  const y = frame.height - shade.height;
  return Object.freeze({
    x: 0,
    y,
    width: frame.width,
    height: shade.height,
    color: shade.color,
    stops: shade.stops,
    strips: Object.freeze(Array.from({ length: shade.height }, (_, row) => Object.freeze({
      x: 0, y: y + row, width: frame.width, height: 1, color: shade.color, alpha: Number(shadeOpacity((row + 0.5) / shade.height).toFixed(3)),
    }))),
  });
})();

/** The whole frame: the browser's picture covers it, under the shade, the band and the bar. */
export const PICTURE_ROOM = Object.freeze({ x: 0, y: 0, width: RECORDING_OVERLAY.frame.width, height: RECORDING_OVERLAY.frame.height });

/**
 * The frame above the band and the bar, its height even: where a shell's
 * grid is drawn, so its newest row — the one at the bottom — is never under
 * the band's text. The rest of the shell's picture is its own backdrop.
 */
export const GRID_ROOM = Object.freeze({
  x: 0,
  y: 0,
  width: RECORDING_OVERLAY.frame.width,
  height: 2 * Math.floor((RECORDING_OVERLAY.frame.height - RECORDING_OVERLAY.band.height - RECORDING_OVERLAY.bar.height) / 2),
});

/** A length in whole, even pixels, which a 4:2:0 video frame can hold exactly. */
function even(value) {
  return 2 * Math.round(value / 2);
}

/**
 * Where a picture of `picture`'s size sits in `room` — the browser's
 * recording in the frame, or a shell's grid in GRID_ROOM: scaled to fit and
 * centred, never cropped, as a rectangle of whole, even pixels that every
 * surface draws as it is. The rooms' sides are even, so the rounded rectangle
 * never leaves them.
 * @param {{ width: number, height: number }} picture
 * @param {{ x: number, y: number, width: number, height: number }} [room]
 */
export function pictureLayout(picture, room = PICTURE_ROOM) {
  const scale = Math.min(room.width / picture.width, room.height / picture.height);
  const width = even(picture.width * scale);
  const height = even(picture.height * scale);
  return { x: room.x + even((room.width - width) / 2), y: room.y + even((room.height - height) / 2), width, height };
}

/** A rectangle standing on the frame's bottom edge, in whole pixels. */
function standing(kind, left, right, height, color, alpha) {
  const { height: frameHeight } = RECORDING_OVERLAY.frame;
  return { kind, x: left, y: frameHeight - height, width: right - left, height, color, alpha };
}

/** One chapter's stretch, inset at either end, as its played and unplayed parts side by side, never overlapping. */
function segmentRects(segment) {
  const { frame, bar } = RECORDING_OVERLAY;
  const left = Math.round(segment.start * frame.width) + bar.inset;
  const right = Math.round(segment.end * frame.width) - bar.inset;
  const split = Math.round(left + segment.played * (right - left));
  const height = segment.current ? bar.height + bar.currentLift : bar.height;
  const rects = [];
  if (split > left) rects.push(standing("fill", left, split, height, bar.fillColor, segment.current ? 1 : bar.dimOpacity));
  if (right > split) rects.push(standing("track", split, right, height, bar.trackColor, segment.current ? bar.currentTrackOpacity : bar.trackOpacity));
  return rects;
}

/**
 * The bar as the rectangles to draw, in drawing order, each with its final
 * colour and alpha: the chapters' filled and unfilled parts, which tile the
 * bottom edge without overlapping (so no alpha is ever applied twice), each
 * chapter inset at either end so neighbours stand apart, then the ticks over
 * them, each centred on its point and rising above the bar — above the taller
 * stretch in the chapter playing. Every edge is a whole pixel, so the parts
 * meet without a seam in either renderer.
 * @param {{ segments: Array<{ start: number, end: number, played: number, current: boolean }>, points: Array<{ at: number, current: boolean }> }} frame
 */
export function barLayout(frame) {
  const { frame: size, bar, tick } = RECORDING_OVERLAY;
  const ticks = frame.points.map((point) => {
    const left = Math.min(size.width - tick.width, Math.max(0, Math.round(point.at * size.width - tick.width / 2)));
    const height = bar.height + tick.rise + (point.current ? bar.currentLift : 0);
    return standing("tick", left, left + tick.width, height, tick.color, 1);
  });
  return [...frame.segments.flatMap(segmentRects), ...ticks];
}
