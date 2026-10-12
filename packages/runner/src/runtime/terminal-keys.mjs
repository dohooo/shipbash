/**
 * The named keys terminal_type presses, in the browser's press vocabulary,
 * and the bytes a terminal sends for each — the table the console's own
 * terminal (@wterm/dom input.js) keys from. Enter is a carriage return: a
 * program in raw mode reads a line feed as a different key, and a clack
 * prompt submits only on "return".
 *
 * The arrows, Home and End follow the program's cursor-key mode (DECCKM),
 * which a full-screen program switches on: the same key, a different
 * sequence, and the emulator knows which one the program asked for.
 */
const FIXED_KEYS = {
  Enter: "\r",
  Tab: "\t",
  Space: " ",
  Escape: "\x1b",
  Backspace: "\x7f",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  "Control+C": "\x03",
  "Control+D": "\x04",
};
const CURSOR_KEYS = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F" };

export const TERMINAL_KEY_NAMES = Object.freeze([...Object.keys(FIXED_KEYS), ...Object.keys(CURSOR_KEYS)]);

/**
 * @param {string} name one of TERMINAL_KEY_NAMES
 * @param {boolean} applicationCursorKeys the program's DECCKM state
 */
export function keySequence(name, applicationCursorKeys) {
  if (Object.hasOwn(FIXED_KEYS, name)) return FIXED_KEYS[name];
  if (Object.hasOwn(CURSOR_KEYS, name)) return `${applicationCursorKeys ? "\x1bO" : "\x1b["}${CURSOR_KEYS[name]}`;
  throw new Error(`Unknown key ${name}.`);
}
