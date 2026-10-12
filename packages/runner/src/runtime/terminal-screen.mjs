/**
 * What a terminal session shows, as a person at it would read it: every PTY
 * chunk goes through a headless emulator, and the agent (and Jev) read its
 * rendered screen instead of the raw bytes — a clack prompt that redraws
 * itself with cursor moves reads as its final frame, not as every frame it
 * drew on the way.
 *
 * The emulator is @wterm/core, the one the console's Terminal tab draws with,
 * so what the agent reads is what the viewer sees.
 *
 * A menu can mark its focused row by style alone (clack draws the other rows
 * dim and nothing else), so two attributes survive into the text: a dim run
 * reads <dim>…</dim> and a reverse-video run (a highlighted row, a drawn
 * cursor) <rev>…</rev>. Colour and bold do not.
 *
 * A line longer than the screen is wide reads as the one line it is, not as
 * the rows the screen folds it into: a URL or a JSON line a CLI prints must
 * reach the agent whole. The emulator does not record which rows it folded
 * (@wterm/core's WASM core keeps no wrap flag), so a row filled to its last
 * column counts as folded into the next one, on the main screen only — unless
 * that column holds a box-drawing or block character: a full-width frame or a
 * rule drawn to the width ends a row, it does not fold one. That is exact for
 * anything without a space at the fold, and a line of exactly the screen's
 * width followed by a hard newline reads joined to the next one. A line
 * folded across the top edge brings at most a screen of its rows back onto
 * the screen. The console's display and the recording keep the rows.
 */
import { WasmBridge } from "@wterm/core";

const DIM = 0x02;
const REVERSE = 0x20;
const INVISIBLE = 0x40;
const MARKED = DIM | REVERSE;

/** A cell's text: nothing for the second half of a wide character, a space for an empty or hidden one. */
function cellText(cell) {
  if (cell.width === 0) return "";
  return (cell.flags & INVISIBLE) !== 0 || cell.char < 32 ? " " : String.fromCodePoint(cell.char);
}

function tags(style, closing) {
  const names = [(style & DIM) !== 0 ? "dim" : null, (style & REVERSE) !== 0 ? "rev" : null].filter(Boolean);
  return closing ? names.reverse().map((name) => `</${name}>`).join("") : names.map((name) => `<${name}>`).join("");
}

/** A row's cells as they read: the second half of a wide character adds nothing. */
function rowCells(cellAt, length) {
  const cells = [];
  for (let col = 0; col < length; col += 1) {
    const cell = cellAt(col);
    if (cell.width !== 0) cells.push(cell);
  }
  return cells;
}

/**
 * The text of a line's cells, trailing blanks dropped, its dim and reverse
 * runs wrapped. A blank carries on the run around it, and a reverse blank is
 * kept at the end — it is where a prompt draws its cursor.
 */
function cellsText(lineCells) {
  const cells = [...lineCells];
  const shown = (cell) => cellText(cell) !== " " || (cell.flags & REVERSE) !== 0;
  while (cells.length > 0 && !shown(cells[cells.length - 1])) cells.pop();
  let text = "";
  let open = 0;
  for (const cell of cells) {
    const style = shown(cell) ? cell.flags & MARKED : open;
    if (style !== open) {
      text += tags(open, true) + tags(style, false);
      open = style;
    }
    text += cellText(cell);
  }
  return text + tags(open, true);
}

/** Whether a row whose last column holds `cell` folds into the next: text runs into the edge, and no frame is drawn there. */
function foldsAt(cell) {
  return cellText(cell) !== " " && !(cell.char >= 0x2500 && cell.char <= 0x259f);
}

/**
 * The physical rows of the screen or the scrollback: their cells, their text
 * (what the read mark compares), and whether the next row continues them.
 */
function screenRow(core, row, foldable) {
  const cells = rowCells((col) => core.getCell(row, col), core.getCols());
  return { cells, text: cellsText(cells), wraps: foldable && foldsAt(core.getCell(row, core.getCols() - 1)) };
}

function scrollbackRow(core, offset) {
  const length = core.getScrollbackLineLen(offset);
  const cells = rowCells((col) => core.getScrollbackCell(offset, col), length);
  return { cells, text: cellsText(cells), wraps: length >= core.getCols() && foldsAt(core.getScrollbackCell(offset, core.getCols() - 1)) };
}

/** Rows joined into the lines they fold, each rendered once. */
function lines(rows) {
  const joined = [];
  let cells = [];
  for (const row of rows) {
    cells.push(...row.cells);
    if (!row.wraps) {
      joined.push(cellsText(cells));
      cells = [];
    }
  }
  if (cells.length > 0) joined.push(cellsText(cells));
  return joined;
}

function screenText(screenLines) {
  const shown = [...screenLines];
  while (shown.length > 0 && shown[shown.length - 1] === "") shown.pop();
  return shown.join("\n");
}

/** Text as a text wait matches it: the marks gone, whitespace collapsed. */
const plain = (text) => text.replace(/<\/?(?:dim|rev)>/gu, "").replace(/\s+/gu, " ").trim();

/**
 * One session's screen. `take` is what a terminal call returns: the lines
 * that scrolled off the top since the last take and were not on its screen —
 * the start of an output longer than the screen, which the screen alone would
 * lose — the screen as it stands, and (`fresh`) the lines of both the last
 * take did not show. `peek` and `shows` read without moving that mark.
 * @param {number} cols
 * @param {number} rows
 */
export async function createTerminalScreen(cols, rows) {
  const core = await WasmBridge.load();
  core.init(cols, rows);
  // Every line that has ever scrolled off, counting the ones the scrollback
  // has since dropped: the mark `take` reads from.
  const scrolledTotal = () => core.getScrollbackCount() + core.getScrollbackDiscardedCount();
  let taken = 0;
  let shownRows = [];
  // What a take would return, rendered once per change: a text wait polls it.
  let rendered = null;
  /**
   * The scrollback rows not yet read, oldest first (offset 0 is the newest).
   * Rows scroll off from the top of the screen the last take showed, so while
   * they still read as its rows they were read there; the first that does not
   * (a clear, a redraw) and everything after it are new. A program that
   * cleared its scrollback (ESC[3J) took the total below the mark.
   */
  const unreadRows = () => {
    const total = scrolledTotal();
    const count = Math.min(total - Math.min(taken, total), core.getScrollbackCount());
    const unread = [];
    for (let offset = count - 1; offset >= 0; offset -= 1) unread.push(scrollbackRow(core, offset));
    let read = 0;
    while (read < unread.length && read < shownRows.length && unread[read].text === shownRows[read]) read += 1;
    return unread.slice(read);
  };
  /**
   * The screen's rows, led by the scrollback rows its first line began on:
   * a line folded across the top edge reads whole, on the screen, and not
   * again among the rows that scrolled off — up to a screen of them, so one
   * huge line cannot carry the whole scrollback onto the screen; the rest of
   * its start stays among the rows that scrolled off.
   */
  const render = () => {
    if (rendered !== null) return rendered;
    const foldable = !core.usingAltScreen();
    const screen = Array.from({ length: core.getRows() }, (_, row) => screenRow(core, row, foldable));
    const head = [];
    for (let offset = 0; foldable && offset < Math.min(core.getScrollbackCount(), core.getRows()); offset += 1) {
      const row = scrollbackRow(core, offset);
      if (!row.wraps) break;
      head.unshift(row);
    }
    const unread = unreadRows();
    const scrolled = unread.slice(0, Math.max(0, unread.length - head.length));
    rendered = { scrolled, screen, scrolledOff: lines(scrolled), screenLines: lines([...head, ...screen]) };
    return rendered;
  };
  return {
    /** @param {Uint8Array} chunk */
    write: (chunk) => {
      core.writeRaw(chunk);
      rendered = null;
    },
    cursorKeysApp: () => core.cursorKeysApp(),
    /** Whether `text` is in what `take` would return now, as `plain` reads both. */
    shows: (text) => {
      const { scrolledOff, screenLines } = render();
      return plain([...scrolledOff, ...screenLines].join("\n")).includes(plain(text));
    },
    take() {
      const { scrolled, screen, scrolledOff, screenLines } = render();
      const previous = new Set(shownRows);
      const fresh = [...scrolled, ...screen.filter((row) => !previous.has(row.text))].map((row) => row.text).join("\n");
      taken = scrolledTotal();
      shownRows = screen.map((row) => row.text);
      rendered = null;
      return { scrolledOff: scrolledOff.join("\n"), screen: screenText(screenLines), altScreen: core.usingAltScreen(), fresh };
    },
    peek: () => ({ screen: screenText(render().screenLines), altScreen: core.usingAltScreen() }),
  };
}
