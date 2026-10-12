/**
 * The overlay's stylesheet, written from the shared spec
 * (`@shipbash/contracts/runtime/recording-overlay.mjs`) that the runner's
 * exporter draws the video from. It decides no layout: the shade, every run
 * of text, the subtitle's box and every rectangle of the bar are placed inline
 * from `SHADE_LAYOUT`, `bandLayout`, `captionLayout` and `barLayout`, and the
 * rules here only give each run the spec's face, size, colour and shadow.
 * Kerning and ligatures are off, as the layout measures text without them,
 * and the face is set with longhands so no later rule's `font` shorthand can
 * turn them back on. Only the synthetic page under the overlay
 * is the console's own.
 */

import { RECORDING_OVERLAY, SHADE_LAYOUT, type RecordingOverlayText } from "@shipbash/contracts/runtime/recording-overlay.mjs";

/** Where Storybook serves the spec's font directory (`.storybook/main.ts` staticDirs). */
const FONT_URL = `/${RECORDING_OVERLAY.fonts.directory}`;

/** A spec colour at a spec opacity, as CSS reads it. */
export function overlayColour(hex: string, opacity: number): string {
  const [red, green, blue] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return `rgb(${String(red)} ${String(green)} ${String(blue)} / ${String(opacity)})`;
}

/**
 * The shade as a CSS gradient from the shared layout's opacity stops: the
 * exporter draws the same stops as one-pixel strips.
 */
export function shadeGradient(): string {
  const stops = SHADE_LAYOUT.stops.map(([at, opacity]) => `${overlayColour(SHADE_LAYOUT.color, opacity)} ${String(at * 100)}%`);
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

/** A run's face and size, as the spec gives them, with kerning and ligatures off. */
function font(run: Pick<RecordingOverlayText, "face" | "size">): string {
  const face = RECORDING_OVERLAY.fonts[run.face];
  return [
    `font-family: "${face.family}";`,
    `font-weight: ${String(face.weight)};`,
    `font-size: ${String(run.size)}px;`,
    "line-height: 1;",
    "font-kerning: none;",
    "font-variant-ligatures: none;",
  ].join(" ");
}

function text(run: RecordingOverlayText): string {
  return `${font(run)} color: ${overlayColour(run.color, run.opacity)};`;
}

function fontFaces(): string {
  return [RECORDING_OVERLAY.fonts.medium, RECORDING_OVERLAY.fonts.bold].map((face) => (
    `@font-face { font-family: "${face.family}"; font-weight: ${String(face.weight)}; src: url("${FONT_URL}/${face.file}") format("truetype"); }`
  )).join("\n");
}

function overlayRules(): string {
  const { counter, title, time, caption, card, shadow } = RECORDING_OVERLAY;
  // The hard shadow the exporter draws under each of the band's runs: straight down, unblurred.
  const bandShadow = `text-shadow: 0 ${String(shadow.offsetY)}px 0 ${overlayColour(shadow.color, shadow.opacity)};`;
  return `
.rov-fit { position: relative; overflow: hidden; border-radius: var(--radius-md); box-shadow: 0 1px 2px rgb(0 0 0 / 12%), 0 8px 24px rgb(0 0 0 / 10%); }
.rov-fit > .rov-frame { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
.rov-frame { position: relative; overflow: hidden; background: #000; -webkit-font-smoothing: antialiased; }
.rov-picture { position: absolute; overflow: hidden; }
.rov-recorded { transform-origin: 0 0; }
.rov-shade { position: absolute; z-index: 1; }
.rov-box { position: absolute; z-index: 2; }
.rov-rect { position: absolute; z-index: 3; }
.rov-run { position: absolute; z-index: 4; transform: translateY(-50%); white-space: pre; }
.rov-counter { ${text(counter)} ${bandShadow} }
.rov-title { ${text(title)} ${bandShadow} }
.rov-time { ${text(time)} ${bandShadow} }
.rov-caption { ${text(caption)} }
.rov-card { ${text(card)} }
`;
}

/** The synthetic page the overlay is drawn over: a made-up invoicing app. */
const PAGE = `
.rov-page { display: grid; grid-template-columns: 232px 1fr; grid-template-rows: 64px 1fr; width: 100%; height: 100%; background: var(--color-bg); color: var(--color-ink); font-family: var(--sans); }
.rov-page-top { grid-column: 1 / -1; display: flex; align-items: center; gap: 16px; padding: 0 28px; border-bottom: 1px solid var(--color-line); background: var(--color-panel); }
.rov-page-logo { width: 28px; height: 28px; border-radius: var(--radius-sm); background: var(--color-blue); }
.rov-page-brand { font-size: 20px; font-weight: 700; }
.rov-page-search { width: 360px; height: 36px; margin-left: 48px; border: 1px solid var(--color-line); border-radius: var(--radius-sm); background: var(--color-panel-muted); }
.rov-page-avatar { width: 34px; height: 34px; margin-left: auto; border-radius: var(--radius-full); background: var(--color-soft); }
.rov-page-nav { display: flex; flex-direction: column; gap: 4px; padding: 20px 14px; border-right: 1px solid var(--color-line); background: var(--color-panel); }
.rov-page-nav span { padding: 10px 14px; border-radius: var(--radius-sm); color: var(--color-muted); font-size: 16px; font-weight: 500; }
.rov-page-nav span[data-active] { background: var(--color-blue-soft); color: var(--color-blue-deep); font-weight: 600; }
.rov-page-main { display: flex; flex-direction: column; gap: 20px; padding: 32px 40px; }
.rov-page-main h2 { margin: 0; font-size: 30px; font-weight: 700; }
.rov-page-card { display: flex; flex-direction: column; gap: 14px; flex: 1; padding: 24px 28px; border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-panel); }
.rov-page-row { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 24px; padding-bottom: 14px; border-bottom: 1px solid var(--color-soft); }
.rov-page-row i { height: 12px; border-radius: var(--radius-full); background: var(--color-soft); }
.rov-page-row i:first-child { background: var(--color-line); }
.rov-page-button { align-self: flex-end; margin-top: auto; padding: 12px 22px; border-radius: var(--radius-sm); background: var(--color-blue); color: #fff; font-size: 16px; font-weight: 600; }
`;

export const OVERLAY_STYLE = `${fontFaces()}\n${overlayRules()}${PAGE}`;
