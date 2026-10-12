/**
 * What is masked in the sandbox shell's output, found over a whole session's
 * text at once (terminal-recording-masking.mjs), so no secret is ever read in
 * pieces. Four sources:
 *
 * - the runner's own redactor: every secret it registered — by the end of the
 *   session, so one registered after it was printed too — in each form it
 *   registered it in, and the patterns every event passes through;
 * - secretlint's recommended rules, which know by its shape a credential the
 *   runner never held — a provider's API key, a database URL's password;
 * - private key blocks, whole or cut short;
 * - the start of a registered secret the session's output ends on: the shell
 *   stopped mid-secret.
 *
 * The text is read through a view that undoes what a terminal adds between a
 * secret's characters without changing what the screen shows:
 *
 * - colour and erase-in-line sequences (`\e[…m`, `\e[…K`) change no cell's
 *   text, so they are nothing in the view: a highlighter's colour inside a
 *   token does not split it;
 * - any other control sequence moves the cursor or the screen, so it is one
 *   neutral character — it ends in a letter (`\e[2J`), which a rule would
 *   otherwise read as part of the word after it;
 * - readline echoes a command longer than a row by writing the next row's
 *   first character, a carriage return and that character again (bash on an
 *   xterm, whose cursor waits at the margin), so where a row has just filled
 *   and the same character follows the return, the first `X\r` is left out.
 *
 * Each match found in the view covers the span of the text it came from; the
 * view keeps only where its positions stop following the text's, so it costs
 * memory by the control sequence, not by the character.
 */
import { lintSource } from "@secretlint/core";
import { creator as recommendedRules } from "@secretlint/secretlint-rule-preset-recommend";

export const REDACTED = "[REDACTED]";
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences is the point.
export const CONTROL_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|[ -/]*[0-Z\\^-~])/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences is the point.
const ZERO_WIDTH_SEQUENCE = /^\u001b\[[0-9;]*[mK]$/u;
/** Where the view stops following the text: a control sequence, or a control character. */
const VIEW_BREAK = new RegExp(`${CONTROL_SEQUENCE.source}|[\\u0000-\\u001f]`, "gu");
/** A control sequence that moves the cursor, in the view: no rule reads it as part of a word. */
const SEQUENCE_MARK = "\u0001";
const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gu;
const KEY_END = /^-----END [A-Z0-9 ]*PRIVATE KEY-----/u;
/** A line of key material: base64, or a header an encrypted PEM key carries. */
const KEY_LINE = /^(?:[A-Za-z0-9+/=]*|(?:Proc-Type|DEK-Info): .*)$/u;
/** Longer than any private key block (an RSA-8192 PEM is about 6.5 KB); what runs past it is not one. */
export const MAX_KEY_BLOCK = 16 * 1024;
/** Shorter than this, the end of the output is not taken for a secret's start. */
const MIN_TRAILING_SECRET = 4;
// The preset, less its comment filter: a `secretlint-disable` a program prints
// must not switch the rules off for the lines after it.
const SECRETLINT_CONFIG = {
  rules: [{
    id: recommendedRules.meta.id,
    rule: recommendedRules,
    rules: [{ id: "@secretlint/secretlint-rule-filter-comments", disabled: true }],
  }],
};

/**
 * Where secretlint's recommended rules find a credential in `text`.
 * @param {string} text
 * @returns {Promise<Array<readonly [number, number]>>}
 */
export async function secretRanges(text) {
  const result = await lintSource({
    source: { content: text, filePath: "terminal", contentType: "text" },
    options: { config: SECRETLINT_CONFIG, noPhysicFilePath: true },
  });
  return result.messages.map((message) => message.range);
}

/** The cells a run of plain text draws: its characters, less control characters. */
function cellCount(segment) {
  let cells = 0;
  for (let unit = 0; unit < segment.length; unit += 1) {
    const code = segment.charCodeAt(unit);
    if (code >= 0x20 && (code < 0xdc00 || code > 0xdfff)) cells += 1;
  }
  return cells;
}

/**
 * The view the rules read, and where its positions stop following the text's
 * one for one: from each mark on, view position `v` is text position
 * `mark.text + v - mark.view`. A cursor-moving sequence's mark in the view
 * also records where its sequence ends in the text.
 * @param {string} text
 * @param {number} columns the pty's width, where readline wraps
 */
function scanView(text, columns) {
  const pieces = [];
  const marks = [{ view: 0, text: 0 }];
  const sequenceEnds = new Map();
  let viewLength = 0;
  let cursor = 0;
  let rowCells = 0;
  let lastCell = "";
  const follow = (end) => {
    if (end <= cursor) return;
    const segment = text.slice(cursor, end);
    pieces.push(segment);
    viewLength += segment.length;
    const cells = cellCount(segment);
    rowCells += cells;
    if (cells) lastCell = String.fromCodePoint(segment.codePointAt(segment.length - (/[\udc00-\udfff]$/u.test(segment) ? 2 : 1)) ?? 0);
    cursor = end;
  };
  const jumpTo = (textIndex) => {
    cursor = textIndex;
    marks.push({ view: viewLength, text: textIndex });
  };
  for (const { 0: token, index: at } of text.matchAll(VIEW_BREAK)) {
    follow(at);
    const rowJustFilled = rowCells > columns && (rowCells - 1) % columns === 0;
    if (token === "\r" && rowJustFilled && text.startsWith(lastCell, at + 1) && text.slice(at - lastCell.length, at) === lastCell) {
      // Readline's wrap: the character before the return is drawn again after it.
      pieces[pieces.length - 1] = pieces[pieces.length - 1].slice(0, -lastCell.length);
      viewLength -= lastCell.length;
      rowCells -= 1;
      jumpTo(at + 1);
    } else if (ZERO_WIDTH_SEQUENCE.test(token)) {
      jumpTo(at + token.length);
    } else if (token.length > 1) {
      sequenceEnds.set(viewLength, at + token.length);
      pieces.push(SEQUENCE_MARK);
      viewLength += 1;
      jumpTo(at + token.length);
    } else {
      follow(at + 1);
      if (token === "\r" || token === "\n") rowCells = 0;
    }
  }
  follow(text.length);
  return { view: pieces.join(""), marks, sequenceEnds };
}

/** The text position of view position `v`. */
function textPosition(marks, v) {
  let low = 0;
  let high = marks.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (marks[middle].view <= v) low = middle;
    else high = middle - 1;
  }
  return marks[low].text + v - marks[low].view;
}

/**
 * Private key blocks: a BEGIN line, and the lines of key material after it up
 * to its END line, or to the first line that is not key material — a key cut
 * short is masked as far as it went — and never past MAX_KEY_BLOCK.
 * @param {string} view
 */
function keyBlockRanges(view) {
  const ranges = [];
  for (const begin of view.matchAll(KEY_BEGIN)) {
    let end = begin.index + begin[0].length;
    for (let lineStart = view.indexOf("\n", end) + 1; lineStart > 0; lineStart = view.indexOf("\n", lineStart) + 1) {
      const lineBreak = view.indexOf("\n", lineStart);
      // A pty ends a line with \r\n, and a file written with CRLF adds a \r of its own.
      const line = view.slice(lineStart, lineBreak === -1 ? view.length : lineBreak).replace(/\r+$/u, "");
      const closing = KEY_END.exec(line);
      if (closing) {
        end = lineStart + closing[0].length;
        break;
      }
      if (!KEY_LINE.test(line) || lineStart + line.length - begin.index > MAX_KEY_BLOCK) break;
      end = lineStart + line.length;
      if (lineBreak === -1) break;
    }
    ranges.push({ start: begin.index, end, replacement: REDACTED });
  }
  return ranges;
}

/** The start of a registered secret the text ends on, at least MIN_TRAILING_SECRET long. */
function trailingSecretRange(view, secrets) {
  let start = view.length;
  for (const secret of secrets) {
    for (let length = Math.min(secret.length - 1, view.length); length >= MIN_TRAILING_SECRET; length -= 1) {
      if (view.endsWith(secret.slice(0, length))) {
        start = Math.min(start, view.length - length);
        break;
      }
    }
  }
  return start < view.length ? [{ start, end: view.length, replacement: REDACTED }] : [];
}

/** The ranges ordered, and those that touch merged into one that replaces them all. */
function mergedRanges(ranges) {
  const merged = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start || right.end - left.end)) {
    const last = merged.at(-1);
    if (last && range.start < last.end) {
      if (range.end > last.end) merged[merged.length - 1] = { start: last.start, end: range.end, replacement: REDACTED };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/**
 * What `text` masks, as ranges of it in order, none overlapping, each with
 * what replaces it.
 * @param {string} text output, escape sequences and all
 * @param {{
 *   redactor: { sensitiveRanges: (text: string) => Array<{ start: number, end: number, replacement: string }>, sensitiveRuntimeValues: ReadonlySet<string> },
 *   columns: number,
 *   scan?: (text: string) => Promise<ReadonlyArray<readonly [number, number]>>,
 *   sessionEnds?: boolean,
 * }} options `sessionEnds`: the text ends where the session did, so a secret's start it ends on is masked
 */
export async function maskedRanges(text, { redactor, columns, scan = secretRanges, sessionEnds = true }) {
  const { view, marks, sequenceEnds } = scanView(text, columns);
  const found = [
    ...redactor.sensitiveRanges(view),
    ...(await scan(view)).map(([start, end]) => ({ start, end, replacement: REDACTED })),
    ...keyBlockRanges(view),
    ...(sessionEnds ? trailingSecretRange(view, redactor.sensitiveRuntimeValues) : []),
  ].filter((range) => range.end > range.start);
  return mergedRanges(found.map((range) => ({
    start: textPosition(marks, range.start),
    end: sequenceEnds.get(range.end - 1) ?? textPosition(marks, range.end - 1) + 1,
    replacement: range.replacement,
  })));
}

/**
 * `text` masked whole.
 * @param {string} text
 * @param {Parameters<typeof maskedRanges>[1]} options
 */
export async function maskTerminalText(text, options) {
  let masked = "";
  let cursor = 0;
  for (const range of await maskedRanges(text, options)) {
    masked += text.slice(cursor, range.start) + range.replacement;
    cursor = range.end;
  }
  return masked + text.slice(cursor);
}
