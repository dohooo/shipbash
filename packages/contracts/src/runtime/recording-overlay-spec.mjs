// The burned-in overlay's design, as numbers. Read through
// recording-overlay.mjs, which is the module the preview and the exporter
// import; this file exists so the caption and layout modules beside it can
// read the spec without importing their own entry point.

const freeze = (value) => Object.freeze(value);

/**
 * The overlay at the recording's own size. Every length is a pixel of a
 * 1280x720 frame, and every type size is an em in pixels, as CSS reads it.
 *
 * The picture fills the frame and the overlay is drawn over it: a `shade`
 * darkening its foot, the `band` — the chapter's counter, its title centred,
 * the time — on the shade, the `bar` under them at the frame's bottom edge,
 * and the narration as a subtitle in a rounded `box` just above the band.
 * Only a shell's grid keeps clear of the band (recording-overlay-layout.mjs
 * GRID_ROOM), so the newest row of output is never under its text.
 *
 * Text is laid out by recording-overlay-layout.mjs, never by the renderer:
 * the layout places every run at an x of its own, breaks the box's lines and
 * cuts every string to the room it has, from the advance widths in
 * recording-overlay-metrics.mjs. Both renderers therefore draw with kerning
 * and ligatures off — CSS `font-kerning: none` and
 * `font-variant-ligatures: none`, libass's simple shaper — so a run is
 * exactly as wide as its advances say.
 *
 * Overflow: narration is first cut into pieces (splitCaption) of at most
 * `caption.maxChars` and shown one after another; the box breaks a piece into
 * at most `caption.maxLines` lines and cuts what still does not fit with
 * `ellipsis`. A chapter title wider than the band's room opens its chapter on
 * a title card — the whole title in the box, in the `card` face, the
 * narration held back, for `card.charMs` a character (20 characters a second,
 * the pace subtitles allow an adult reader) and never less than a caption
 * piece's minimum — while the band shows it cut. The preview and the video
 * cut at the same character because they read the same layout.
 *
 * The font is Inter 4.1 (SIL Open Font License), Medium and Bold, cut down to
 * Latin and common punctuation by scripts/build-recording-overlay-fonts.ts
 * and kept with the licence in the directory beside this module. Two static
 * faces rather than the one variable file: libass 0.17 reads only a variable
 * font's default instance from a fonts directory, so every weight rendered as
 * Regular. Each face is named by the family name its file declares, which is
 * what libass matches a style's font on: the Medium file declares "Inter
 * Medium", the Bold file "Inter" with bold set. A character outside the
 * subset falls back to another font in both renderers, and the layout
 * reserves an em for a wide (CJK) one and `fallbackAdvance` ems for any other.
 */
export const RECORDING_OVERLAY = freeze({
  frame: freeze({ width: 1280, height: 720 }),
  fonts: freeze({
    directory: "recording-overlay-fonts",
    medium: freeze({ file: "Inter-Medium.ttf", family: "Inter Medium", weight: 500, bold: false }),
    bold: freeze({ file: "Inter-Bold.ttf", family: "Inter", weight: 700, bold: true }),
    fallbackAdvance: 0.6,
  }),
  ellipsis: "…",
  /** Opacity `stops` from the shade's top (0) to the frame's bottom edge (1). */
  shade: freeze({ height: 51, color: "#000000", stops: freeze([freeze([0, 0]), freeze([0.45, 0.6]), freeze([1, 0.85])]) }),
  /**
   * The band's one row, standing on the bar. `sideWidth` is what the counter
   * and the time each keep at either end, so the title's room is the same at
   * every moment; `gap` is the least space between the title and either.
   */
  band: freeze({ height: 26, paddingX: 16, sideWidth: 96, gap: 18 }),
  /** The band's runs drawn over a picture of any colour: a hard shadow under each. */
  shadow: freeze({ color: "#000000", opacity: 0.6, offsetY: 1 }),
  counter: freeze({ face: "medium", size: 13, color: "#ffffff", opacity: 0.6 }),
  title: freeze({ face: "bold", size: 16, color: "#ffffff", opacity: 1 }),
  time: freeze({ face: "medium", size: 13, color: "#ffffff", opacity: 0.7 }),
  caption: freeze({
    face: "medium", size: 22, color: "#ffffff", opacity: 1, lineHeight: 1.4, maxLines: 2, maxChars: 64, minPieceMs: 2_000,
  }),
  /** A chapter's whole title in the box, `charMs` a character. */
  card: freeze({ face: "bold", size: 22, color: "#ffffff", opacity: 1, charMs: 50 }),
  /** The subtitle's box: it hugs its lines, and stands `gap` above the band. */
  box: freeze({ maxWidth: 960, paddingX: 16, paddingTop: 7, paddingBottom: 8, radius: 10, gap: 10, color: "#000000", opacity: 0.72 }),
  bar: freeze({
    height: 3,
    /** How much taller the chapter playing stands. */
    currentLift: 2,
    /** What each chapter's stretch gives up at either end, so neighbours stand apart. */
    inset: 1,
    trackColor: "#ffffff",
    trackOpacity: 0.16,
    currentTrackOpacity: 0.28,
    fillColor: "#2563eb",
    /** The fill's opacity in every chapter but the one playing. */
    dimOpacity: 0.55,
  }),
  tick: freeze({ width: 2, rise: 5, color: "#ffffff" }),
});
