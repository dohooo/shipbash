// Where the burned-in overlay's face files are on disk, for the runner's
// exporter to hand libass. A module of its own because it reads the file
// system's view of this package: the console's bundles import
// recording-overlay.mjs and never this.

import { fileURLToPath } from "node:url";

import { RECORDING_OVERLAY } from "./recording-overlay-spec.mjs";

/**
 * The absolute paths of the overlay's face files beside this module — only
 * the fonts, never the licence beside them, which libass would try to load.
 * @returns {string[]}
 */
export function recordingOverlayFontFiles() {
  const { directory, medium, bold } = RECORDING_OVERLAY.fonts;
  return [medium, bold].map((face) => fileURLToPath(new URL(`./${directory}/${face.file}`, import.meta.url)));
}
