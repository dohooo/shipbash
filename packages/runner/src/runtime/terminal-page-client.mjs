// @ts-check
// The replay export's terminal page, the half that runs in the page: one
// @wterm/dom emulator at a time, opened at a recording's grid and never
// resized, read-only, placed where the export says, and a write that answers
// once the renderer has painted what it was given. terminal-page.mjs serves
// this module to the page and calls its exports; it runs nowhere else.
import { WTerm } from "@wterm/dom";

/** @type {WTerm | null} */
let term = null;
/** @type {HTMLElement | null} */
let screen = null;

/** Resolves once the renderer's scheduled paint (an animation frame) has run. */
function painted() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve(undefined));
  });
}

/** @param {string} base64 */
function bytes(base64) {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

/** The one monospace face (terminal-theme.css), both weights, loaded before wterm measures a cell. */
async function monoLoaded() {
  const mono = getComputedStyle(document.documentElement).getPropertyValue("--mono");
  await Promise.all([`12px ${mono}`, `bold 12px ${mono}`].map((font) => document.fonts.load(font)));
}

/**
 * A fresh emulator at `cols`x`rows` in the theme's class, the page painted in
 * the theme's background; answers the emulator's own size.
 * @param {number} cols
 * @param {number} rows
 * @param {string} themeClass
 */
export async function open(cols, rows, themeClass) {
  term?.destroy();
  screen?.remove();
  await monoLoaded();
  const element = document.createElement("div");
  element.id = "screen";
  element.className = themeClass;
  document.body.append(element);
  screen = element;
  term = new WTerm(element, { cols, rows, autoResize: false, onData: () => {} });
  await term.init();
  document.body.style.background = getComputedStyle(element).getPropertyValue("--term-bg");
  await painted();
  return { width: element.offsetWidth, height: element.offsetHeight };
}

/**
 * Puts the emulator at `x`,`y`, scaled to the rectangle the export lays it out in.
 * @param {number} x
 * @param {number} y
 * @param {number} scaleX
 * @param {number} scaleY
 */
export function place(x, y, scaleX, scaleY) {
  if (!screen) throw new Error("No terminal is open.");
  screen.style.transform = `translate(${String(x)}px, ${String(y)}px) scale(${String(scaleX)}, ${String(scaleY)})`;
}

/**
 * Writes the shell's output, base64 as the recording keeps it, and waits for the paint.
 * @param {string[]} chunks
 */
export async function write(chunks) {
  if (!term) throw new Error("No terminal is open.");
  for (const chunk of chunks) term.write(bytes(chunk));
  await painted();
}
