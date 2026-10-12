// The burned-in overlay as an ASS script for libass.
//
// Nothing here decides what the overlay shows or where: overlayFrame answers
// what shows at a moment, bandLayout where each run of the band sits and what
// of it fits, captionLayout the subtitle's box and its lines, barLayout the
// bar's rectangles and SHADE_LAYOUT the shade's strips, in their final
// colours — the same answers the console's Storybook preview draws from, in
// the same font files. This module only writes them down as events: the text
// and the box between the moments they change (every whole second, every
// chapter and the end of its title card, every caption piece), the bar for
// each stretch a chapter plays, whose fill grows under an animated clip, and
// the shade under it all. libass must shape simply and without kerning, as the
// layout measures, so the script says `Kerning: no` and the exporter runs the
// filter with shaping=simple.

import {
  RECORDING_OVERLAY,
  SHADE_LAYOUT,
  bandLayout,
  barLayout,
  captionLayout,
  captionPieces,
  overlayFrame,
  shownCues,
  titleCardEnds,
} from "@shipbash/contracts/runtime/recording-overlay.mjs";
import { RECORDING_OVERLAY_METRICS } from "@shipbash/contracts/runtime/recording-overlay-metrics.mjs";

import { assAlpha, assColour, assDialogue, assDocument, assGlyph, assStyleColour } from "./ass-subtitles.mjs";

const RECT_STYLE = "rect";
const LAYER = Object.freeze({ shade: 0, box: 1, bar: 2, tick: 3, text: 4 });
/** The band's runs, each drawn over the picture with the spec's shadow under it. */
const BAND_RUNS = Object.freeze(["counter", "title", "time"]);
/** How far a quarter circle's control points stand from its corner, as a share of the radius. */
const BEZIER_CORNER = 1 - 0.5523;

/** Each run's style name, and the spec's face, size and colour it is drawn in. */
function runStyles() {
  const { counter, title, time, caption, card } = RECORDING_OVERLAY;
  return { counter, title, time, caption, card };
}

function number(value) {
  return String(Number(value.toFixed(3)));
}

/**
 * The ASS size that draws a face at `size` em pixels. libass sizes a face so
 * that its OS/2 win ascent and descent together span the font size.
 */
function assFontSize(face, size) {
  const metrics = RECORDING_OVERLAY_METRICS[face];
  return (size * (metrics.winAscent + metrics.winDescent)) / metrics.unitsPerEm;
}

function textStyle(name, run) {
  const face = RECORDING_OVERLAY.fonts[run.face];
  const colour = assStyleColour(run.color, run.opacity);
  const { shadow } = RECORDING_OVERLAY;
  // The back colour is the shadow's, which a band run's event turns on; italic,
  // underline, strike-out off; no scaling, spacing or angle; no border or
  // shadow of the style's own; anchored at the left middle, which \pos places.
  return [`Style: ${name}`, face.family, number(assFontSize(run.face, run.size)), colour, colour, "&H00000000", assStyleColour(shadow.color, shadow.opacity), face.bold ? "-1" : "0", "0,0,0,100,100,0,0,1,0,0,4,0,0,0,1"].join(",");
}

/** The shapes' style: a drawing takes its colour from its own override, and its font is never drawn. */
function rectStyle() {
  const colour = assStyleColour("#ffffff");
  return [`Style: ${RECT_STYLE}`, RECORDING_OVERLAY.fonts.medium.family, "20", colour, colour, "&H00000000", "&H00000000", "0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1"].join(",");
}

function drawing({ x, y, width, height }) {
  return `m ${number(x)} ${number(y)} l ${number(x + width)} ${number(y)} l ${number(x + width)} ${number(y + height)} l ${number(x)} ${number(y + height)}`;
}

/** A rectangle with its corners rounded to `radius`, each a quarter circle as one cubic bezier. */
function roundedDrawing({ x, y, width, height, radius }) {
  const r = Math.min(radius, width / 2, height / 2);
  const k = r * BEZIER_CORNER;
  const [left, top, right, bottom] = [x, y, x + width, y + height];
  const at = (...points) => points.map(number).join(" ");
  return [
    `m ${at(left + r, top)}`,
    `l ${at(right - r, top)}`,
    `b ${at(right - k, top, right, top + k, right, top + r)}`,
    `l ${at(right, bottom - r)}`,
    `b ${at(right, bottom - k, right - k, bottom, right - r, bottom)}`,
    `l ${at(left + r, bottom)}`,
    `b ${at(left + k, bottom, left, bottom - k, left, bottom - r)}`,
    `l ${at(left, top + r)}`,
    `b ${at(left, top + k, left + k, top, left + r, top)}`,
  ].join(" ");
}

/** One shape held for a while, in its colour and alpha, optionally under a clip. */
function shapeEvent(startMs, endMs, layer, shape, path, clip = "") {
  const colour = `\\1c${assColour(shape.color)}\\1a&H${assAlpha(shape.alpha)}&`;
  return assDialogue({ startMs, endMs, style: RECT_STYLE, layer, text: `{\\an7\\pos(0,0)${colour}${clip}\\p1}${path}{\\p0}` });
}

function rectEvent(startMs, endMs, layer, rect, clip = "") {
  return shapeEvent(startMs, endMs, layer, rect, drawing(rect), clip);
}

/** Whether a stretch survives ASS's centisecond clock. */
function lasts(startMs, endMs) {
  return Math.round(endMs / 10) > Math.round(startMs / 10);
}

function sortedWithin(times, durationMs) {
  return [...new Set(times)].filter((at) => at >= 0 && at <= durationMs).sort((left, right) => left - right);
}

/** Every moment a run of text can change: each whole second, each chapter and its title card's end, each caption piece. */
function textChanges(recording) {
  const times = [0, recording.durationMs, ...titleCardEnds(recording)];
  for (let at = 1_000; at < recording.durationMs; at += 1_000) times.push(at);
  for (const chapter of recording.chapters) times.push(chapter.startMs, chapter.endMs);
  for (const cue of shownCues(recording)) {
    for (const piece of captionPieces(cue)) times.push(piece.startMs, piece.endMs);
  }
  return sortedWithin(times, recording.durationMs);
}

/**
 * What is drawn at `atMs`, keyed by what it is: the band's runs, the
 * subtitle's lines (`line-0`, `line-1`) and its box, each with what places it.
 */
function drawnAt(recording, atMs) {
  const frame = overlayFrame(recording, atMs);
  const band = bandLayout(frame);
  const caption = captionLayout(frame);
  const drawn = new Map();
  for (const key of BAND_RUNS) {
    const run = band[key];
    if (run) drawn.set(key, { kind: "text", style: key, x: run.x, y: band.centerY, text: run.text, shadow: true });
  }
  if (caption !== null) {
    for (const [index, line] of caption.lines.entries()) {
      drawn.set(`line-${String(index)}`, { kind: "text", style: caption.style, x: line.x, y: line.centerY, text: line.text, shadow: false });
    }
    drawn.set("box", { kind: "box", box: caption.box });
  }
  return drawn;
}

/** Whether two moments draw a thing the same way, so one event holds it across both. */
function sameDrawing(left, right) {
  if (left.kind === "box" && right.kind === "box") {
    return ["x", "y", "width", "height"].every((side) => left.box[side] === right.box[side]);
  }
  return left.style === right.style && left.text === right.text && left.x === right.x && left.y === right.y;
}

function textEvent(run) {
  const text = [...run.text].map(assGlyph).join("");
  const shadow = run.shadow ? `\\xshad0\\yshad${String(RECORDING_OVERLAY.shadow.offsetY)}` : "";
  return assDialogue({
    startMs: run.startMs,
    endMs: run.endMs,
    style: run.style,
    layer: LAYER.text,
    text: `{\\an4\\pos(${number(run.x)},${number(run.y)})${shadow}}${text}`,
  });
}

function drawnEvent(held) {
  return held.kind === "box" ? shapeEvent(held.startMs, held.endMs, LAYER.box, held.box, roundedDrawing(held.box)) : textEvent(held);
}

/** The band's runs and the subtitle, each one event for as long as it is drawn the same way. */
function textEvents(recording) {
  const changes = textChanges(recording);
  const open = new Map();
  const held = [];
  for (let index = 0; index < changes.length - 1; index += 1) {
    const [startMs, endMs] = [changes[index], changes[index + 1]];
    const drawn = drawnAt(recording, startMs);
    for (const [key, thing] of open) {
      const next = drawn.get(key);
      if (next && sameDrawing(thing, next)) {
        thing.endMs = endMs;
        drawn.delete(key);
      } else {
        held.push(thing);
        open.delete(key);
      }
    }
    for (const [key, thing] of drawn) open.set(key, { ...thing, startMs, endMs });
  }
  held.push(...open.values());
  return held.filter((thing) => lasts(thing.startMs, thing.endMs)).map(drawnEvent);
}

/** barLayout's rectangles for one stretch of the bar alone, drawn as the chapter playing. */
function playingRects(segment) {
  return barLayout({ segments: [{ ...segment, current: true }], points: [] });
}

/** Where barLayout splits the chapter playing into its filled and unfilled parts at a moment. */
function splitAt(recording, index, atMs) {
  const [first] = playingRects(overlayFrame(recording, atMs).segments[index]);
  return first.kind === "fill" ? first.x + first.width : first.x;
}

/**
 * The chapter playing, as barLayout's whole filled and whole unfilled
 * rectangles, each under a clip that moves from barLayout's split at
 * `startMs` to its split at `endMs`: the split barLayout draws at any moment
 * in between. A chapter too narrow to keep anything past its insets is no
 * rectangle at all, and is drawn as nothing.
 */
function currentSegmentEvents(recording, index, startMs, endMs) {
  const segment = overlayFrame(recording, startMs).segments[index];
  const [fill] = playingRects({ ...segment, played: 1 });
  const [track] = playingRects({ ...segment, played: 0 });
  if (!fill || !track) return [];
  const [from, to] = [splitAt(recording, index, startMs), splitAt(recording, index, endMs)];
  const [top, bottom] = [fill.y, fill.y + fill.height];
  const clip = (fromLeft, fromRight, toLeft, toRight) => (
    `\\clip(${String(fromLeft)},${String(top)},${String(fromRight)},${String(bottom)})\\t(0,${String(Math.round(endMs - startMs))},\\clip(${String(toLeft)},${String(top)},${String(toRight)},${String(bottom)}))`
  );
  return [
    rectEvent(startMs, endMs, LAYER.bar, fill, clip(fill.x, from, fill.x, to)),
    rectEvent(startMs, endMs, LAYER.bar, track, clip(from, track.x + track.width, to, track.x + track.width)),
  ];
}

/** The bar for each stretch between chapter boundaries: the other chapters and the ticks held, the one playing moving. */
function barEvents(recording) {
  const bounds = overlayFrame(recording, 0).segments.flatMap((segment) => [segment.startMs, segment.endMs]);
  const changes = sortedWithin([0, recording.durationMs, ...bounds], recording.durationMs);
  const events = [];
  for (let index = 0; index < changes.length - 1; index += 1) {
    const [startMs, endMs] = [changes[index], changes[index + 1]];
    if (!lasts(startMs, endMs)) continue;
    const frame = overlayFrame(recording, startMs);
    const playing = frame.segments.findIndex((segment) => segment.current);
    const held = barLayout({ ...frame, segments: frame.segments.filter((segment) => !segment.current) });
    for (const rect of held) events.push(rectEvent(startMs, endMs, rect.kind === "tick" ? LAYER.tick : LAYER.bar, rect));
    if (playing !== -1) events.push(...currentSegmentEvents(recording, playing, startMs, endMs));
  }
  return events;
}

/** The shade, strip by strip, for the whole recording. */
function shadeEvents(recording) {
  return SHADE_LAYOUT.strips.map((strip) => rectEvent(0, recording.durationMs, LAYER.shade, strip));
}

/**
 * The whole overlay for a recording on the replay's timeline, as an ASS
 * script at the spec's 1280x720, which libass scales to the video.
 * @param {import("@shipbash/contracts/runtime/recording-overlay.mjs").OverlayRecording} recording
 */
export function overlayAssDocument(recording) {
  const styles = runStyles();
  return assDocument({
    ...RECORDING_OVERLAY.frame,
    info: ["Kerning: no"],
    styles: [rectStyle(), ...Object.entries(styles).map(([name, run]) => textStyle(name, run))],
    events: [...shadeEvents(recording), ...barEvents(recording), ...textEvents(recording)],
  });
}
