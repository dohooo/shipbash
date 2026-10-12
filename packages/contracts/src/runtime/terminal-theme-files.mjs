// Where the terminal's shared stylesheet and its faces are on disk, for the
// runner's replay export to serve to its page. A module of its own because it
// reads the file system's view of this package: the console imports
// terminal-theme/terminal-theme.css itself and never this.

import { fileURLToPath } from "node:url";

/** The theme's directory beside this module, its sheet, and the class it is keyed on beside `wterm` (the console's `theme="shipbash"`). */
export const TERMINAL_THEME = Object.freeze({
  directory: "terminal-theme",
  sheet: "terminal-theme.css",
  className: "theme-shipbash",
});

/** The absolute path of the theme's directory: the sheet, the faces it names and their licence. */
export function terminalThemeDirectory() {
  return fileURLToPath(new URL(`./${TERMINAL_THEME.directory}/`, import.meta.url));
}
