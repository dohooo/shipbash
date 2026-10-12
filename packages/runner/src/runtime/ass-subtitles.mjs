// The subtitle primitives the exported replay's overlays are drawn with.
//
// What the export burns in over its pictures — the agent's cursor and the
// band, bar and narration (overlay-ass.mjs) — is an ASS subtitle rendered by
// libass inside the same ffmpeg that encodes the video; the image already
// carries libass (`--enable-libass`).
//
// This module holds only what both overlays share: the time format, the
// colour order, text escaping, and the document skeleton.

/** `H:MM:SS.CC` — ASS keeps centiseconds, not milliseconds. */
function assTime(ms) {
  const total = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0));
  const centiseconds = Math.floor(total / 10) % 100;
  const seconds = Math.floor(total / 1_000) % 60;
  const minutes = Math.floor(total / 60_000) % 60;
  const hours = Math.floor(total / 3_600_000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${String(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`;
}

/**
 * `#rrggbb` as ASS's `&HBBGGRR&`: the byte order is reversed from CSS, which
 * is the single easiest thing to get wrong here.
 */
export function assColour(hex) {
  const digits = /^#?([0-9a-f]{6})$/iu.exec(String(hex));
  if (!digits) return "&HFFFFFF&";
  const [red, green, blue] = [0, 2, 4].map((at) => digits[1].slice(at, at + 2).toUpperCase());
  return `&H${blue}${green}${red}&`;
}

/** An opacity as ASS alpha, which counts transparency: 00 is opaque, FF clear. */
export function assAlpha(opacity) {
  return Math.round((1 - opacity) * 255).toString(16).toUpperCase().padStart(2, "0");
}

/** The same colour in the form a `Style:` line takes: `&HAABBGGRR`, opaque unless an opacity says otherwise. */
export function assStyleColour(hex, opacity = 1) {
  return `&H${assAlpha(opacity)}${assColour(hex).slice(2, 8)}`;
}

/**
 * One character as ASS body text. libass reads exactly five escapes —
 * `\N`, `\n`, `\h`, `\{` and `\}` — and a backslash before anything else is
 * simply drawn, so `{` and `}` are escaped and a backslash needs defusing only
 * against the character that follows it. An empty override block cannot do
 * that job: `\{` is one of the five, so `\{}` draws `{}` and loses the
 * backslash entirely. A zero-width space can: it is not one of the five, and
 * being default-ignorable it is shaped away, so the backslash is drawn and the
 * run keeps the width the layout measured. Verified against ffmpeg's libass
 * in the runner image, where `'%{http_code}\n'` reads back as itself.
 */
const ASS_ESCAPE_FENCE = "\u200b";

export function assGlyph(glyph) {
  if (glyph === "{") return "\\{";
  if (glyph === "}") return "\\}";
  if (glyph === "\\") return `\\${ASS_ESCAPE_FENCE}`;
  return glyph;
}

/**
 * One `Dialogue:` line. `Name` and the margins stay at their defaults: the
 * overlays position everything themselves with `\pos` or `\move`.
 */
export function assDialogue({ startMs, endMs, style, text, layer = 0 }) {
  return `Dialogue: ${String(layer)},${assTime(startMs)},${assTime(endMs)},${style},,0,0,0,,${text}`;
}

const STYLE_FORMAT = "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding";
const EVENT_FORMAT = "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";

/**
 * A complete ASS script. `PlayRes` is the video's own size, so every
 * coordinate in the events below is a video pixel; `WrapStyle: 2` turns off
 * word wrapping, which a run the layout already cut must never have. `info` adds lines
 * of its own to the script's header.
 */
export function assDocument({ width, height, styles, events, info = [] }) {
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${String(Math.round(width))}`,
    `PlayResY: ${String(Math.round(height))}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    ...info,
    "",
    "[V4+ Styles]",
    STYLE_FORMAT,
    ...styles,
    "",
    "[Events]",
    EVENT_FORMAT,
    ...events,
    "",
  ].join("\n");
}
