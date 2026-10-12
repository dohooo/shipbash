// A shell's recorded log (terminal-lane.mjs writes one per session, masked
// whole when the lane closes), once the walk is over: its header decides
// whether the replay can draw the shell (recording-finalize.mjs), and the
// whole log is read once, to draw it (terminal-frames.mjs).
import { open, readFile } from "node:fs/promises";

import { maskedRecordingHeader } from "./terminal-recording-masking.mjs";

/**
 * Whether the log at `path` can be drawn, from its header alone: masked (a
 * log the runner did not mask is drawn by no one), with a clock and a grid. A
 * masked log's header is its only line that is not output
 * (terminal-recording-masking.mjs), so this answers as readTerminalLog does
 * without reading the output.
 * @param {string} path
 */
export async function terminalLogDrawable(path) {
  return placedHeader(await maskedRecordingHeader(path, { open })) !== null;
}

/**
 * The log at `path`, parsed, or null when it cannot be drawn: missing, not
 * masked, or with no clock or grid in its header.
 * @param {string} path
 */
export async function readTerminalLog(path) {
  if (!(await maskedRecordingHeader(path, { open }))) return null;
  return readFile(path, "utf8").then(parseTerminalLog, () => null);
}

/** The header's clock and grid, or null when it has neither. */
function placedHeader(header) {
  const startedAt = Date.parse(String(header?.startedAt));
  const { cols, rows } = header ?? {};
  return Number.isSafeInteger(startedAt) && startedAt > 0 && isCount(cols) && isCount(rows) ? { startedAt, cols, rows } : null;
}

/**
 * One session's recording: the header's anchor on the recording's clock (the
 * lane's `now`, recording-now.mjs) and grid, plus every
 * output chunk (still base64, as the page decodes it) with the offset it
 * was written at. A log whose header has no epoch cannot be placed against the
 * video, and one with no grid cannot be drawn as the programs in it drew
 * themselves; either answers null.
 * @param {string} text
 * @returns {{ startedAt: number, cols: number, rows: number, entries: Array<{ atMs: number, data: string }> } | null}
 */
export function parseTerminalLog(text) {
  let header = null;
  const entries = [];
  for (const line of String(text).split("\n")) {
    const value = parsedLine(line);
    if (Array.isArray(value)) {
      const atMs = Number(value[0]);
      if (value[1] === "o" && typeof value[2] === "string" && Number.isFinite(atMs)) entries.push({ atMs, data: value[2] });
    } else if (typeof value === "object" && value !== null) {
      header = value;
    }
  }
  const placed = placedHeader(header);
  if (!placed) return null;
  entries.sort((left, right) => left.atMs - right.atMs);
  return { ...placed, entries };
}

function parsedLine(line) {
  try {
    return line.trim() ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

function isCount(value) {
  return Number.isInteger(value) && value > 0;
}
