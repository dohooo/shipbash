// The agent's cursor, burned into the exported replay.
//
// The console's player animates the cursor with a spring on its own wall
// clock; an exporter cannot run that, and would not want to — the export has
// to be reproducible from the recording alone. So each hop becomes one
// subtitle event carrying a `\move`, which libass interpolates along the
// video's own clock. The arrow and the click ring are vector drawings (`\p`),
// so the export ships no image assets.
//
// The capture already stamps a pointer POINTER_LEAD_MS BEFORE the action it
// belongs to (recording-capture.mjs), so the cursor arrives as the click
// lands — the flight below fills exactly that lead.
import { POINTER_LEAD_MS } from "@shipbash/contracts/runtime/recording-bounds.mjs";

import { assDialogue, assDocument, assStyleColour } from "./ass-subtitles.mjs";

/** The console's click pulse (agent-cursor-view.ts) lasts this long. */
const PULSE_MS = 480;
/** Radius 14 px growing to 36 px, as a percentage scale for `\t`. */
const PULSE_GROWTH_PERCENT = 257;
/** Below 1 an ASS transition starts fast and settles, like the console's ease. */
const PULSE_EASE = 0.35;
/** Actions the console pulses for; a hover or a scroll gets no ring. */
const PULSE_ACTIONS = new Set(["click", "dblclick", "check", "uncheck", "select"]);
const CURSOR_STYLE_NAME = "cur";
/**
 * The arrow, at `\p2` (half-pixel) scale:
 * tip at the drawing's origin, which `\an7` pins to the pointer itself.
 */
const ARROW_PATH = "m 0 0 l 0 32 l 9 24 l 22 24";
/** A 28-unit circle (radius 14 px at `\p2`) as four bezier quarters. */
const RING_PATH = "m -28 0 b -28 -15 -15 -28 0 -28 b 15 -28 28 -15 28 0 b 28 15 15 28 0 28 b -15 28 -28 15 -28 0";

/**
 * The pointers on this video, in timeline order, each in the video's pixels.
 * @param {import("./recording-playback.mjs").Playback["pointers"]} pointers
 */
function placedPointers(pointers, durationMs, video) {
  return pointers.filter((pointer) => pointer.atMs < durationMs).map((pointer) => ({
    atMs: Math.round(pointer.atMs),
    x: Math.round(pointer.x * video.width),
    y: Math.round(pointer.y * video.height),
    action: pointer.action,
  })).sort((left, right) => left.atMs - right.atMs);
}

function arrowEvent(pointer, previous, endMs) {
  const position = previous === null
    ? `\\pos(${String(pointer.x)},${String(pointer.y)})`
    : `\\move(${String(previous.x)},${String(previous.y)},${String(pointer.x)},${String(pointer.y)},0,${String(Math.min(POINTER_LEAD_MS, endMs - pointer.atMs))})`;
  return assDialogue({
    startMs: pointer.atMs,
    endMs,
    style: CURSOR_STYLE_NAME,
    layer: 1,
    text: `{\\an7${position}\\p2}${ARROW_PATH}{\\p0}`,
  });
}

/** The ring lands where the flight ends, not where it began. */
function pulseEvent(pointer, endMs) {
  const startMs = pointer.atMs + Math.min(POINTER_LEAD_MS, endMs - pointer.atMs);
  const transition = `\\t(0,${String(PULSE_MS)},${String(PULSE_EASE)},\\fscx${String(PULSE_GROWTH_PERCENT)}\\fscy${String(PULSE_GROWTH_PERCENT)}\\alpha&HFF&)`;
  return assDialogue({
    startMs,
    endMs: startMs + PULSE_MS,
    style: CURSOR_STYLE_NAME,
    text: `{\\an5\\pos(${String(pointer.x)},${String(pointer.y)})\\1a&HFF&\\3c&HEB6325&\\bord2${transition}\\p2}${RING_PATH}{\\p0}`,
  });
}

/**
 * Every cursor event for one recording. Each pointer holds the screen until
 * the next one takes over, and the last holds to the end of the video.
 * @param {{ pointers: Array<{ atMs: number, x: number, y: number, action?: string }>, durationMs: number, video: { width: number, height: number } }} input
 */
export function cursorOverlayEvents({ pointers, durationMs, video }) {
  const placed = placedPointers(pointers, durationMs, video);
  const events = [];
  for (const [index, pointer] of placed.entries()) {
    const endMs = placed[index + 1]?.atMs ?? Math.round(durationMs);
    if (endMs <= pointer.atMs) continue;
    events.push(arrowEvent(pointer, placed[index - 1] ?? null, endMs));
    if (PULSE_ACTIONS.has(pointer.action)) events.push(pulseEvent(pointer, endMs));
  }
  return events;
}

/** The finished subtitle file laid over the browser segments. */
export function cursorAssDocument(events, video) {
  const style = [
    `Style: ${CURSOR_STYLE_NAME}`,
    "DejaVu Sans Mono",
    "12",
    assStyleColour("#ffffff"),
    assStyleColour("#ffffff"),
    // The console strokes the arrow in near-black at 85% opacity.
    "&H260A0A0C",
    assStyleColour("#000000"),
    "0,0,0,0,100,100,0,0,1,1,0,7,0,0,0,1",
  ].join(",");
  return assDocument({ width: video.width, height: video.height, styles: [style], events });
}
