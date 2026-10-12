/**
 * A session's recording masked, once it has ended: the file the terminal lane
 * wrote raw (a header line, then `[ms, "o", base64]` frames) is read frame by
 * frame, its frames' text is masked as one text (terminal-text-masking.mjs),
 * and the file is written again with every frame's timestamp kept. This is
 * the only copy anyone reads, and every reader checks for the header this
 * writes (`maskedRecordingHeader`) before it reads or keeps a log. The header
 * is the masked file's first line and its only line that is not a frame.
 *
 * A match becomes `[REDACTED]` in the frame it starts in, and its characters
 * go from every frame it spans. A character whose bytes two frames split
 * belongs to the frame it is completed in.
 *
 * Memory is bounded by a window, not by the session: the text is masked
 * WINDOW characters at a time, each window reaching OVERLAP characters into
 * the next so a match that crosses the cut is found whole in one of them; the
 * cut is at a frame boundary no match crosses, after a line break when there
 * is one.
 */
import { StringDecoder } from "node:string_decoder";

import { maskedRanges } from "./terminal-text-masking.mjs";

/** The lane's geometry (terminal-lane.mjs), for a header that lacks it. */
const DEFAULT_COLUMNS = 100;
/** Characters of output masked at once. */
const WINDOW = 256 * 1024;
/** Longer than any match: a key block (MAX_KEY_BLOCK), a token, a registered secret in any form. */
const OVERLAP = 64 * 1024;
const READ_BYTES = 64 * 1024;
const HEADER_BYTES = 4_096;

/** The file's lines, read a block at a time. */
async function* recordingLines(handle) {
  const buffer = Buffer.alloc(READ_BYTES);
  const decoder = new StringDecoder("utf8");
  let carried = "";
  for (let position = 0; ; ) {
    const { bytesRead } = await handle.read(buffer, 0, READ_BYTES, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    const lines = (carried + decoder.write(buffer.subarray(0, bytesRead))).split("\n");
    carried = lines.pop() ?? "";
    yield* lines;
  }
  carried += decoder.end();
  if (carried) yield carried;
}

/** An output frame's time and bytes, or null for a line that is not one. */
function outputFrame(line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return null;
  }
  if (!Array.isArray(frame) || frame[1] !== "o" || typeof frame[0] !== "number" || typeof frame[2] !== "string") return null;
  return { atMs: frame[0], bytes: Buffer.from(frame[2], "base64") };
}

/** Each frame's text with the ranges (of the frames' text joined) replaced. */
function placeRanges(frames, ranges) {
  let frameStart = 0;
  let next = 0;
  return frames.map(({ atMs, text }) => {
    const frameEnd = frameStart + text.length;
    let placed = "";
    let cursor = frameStart;
    while (next < ranges.length && ranges[next].start < frameEnd) {
      const range = ranges[next];
      if (range.start >= frameStart) placed += text.slice(cursor - frameStart, range.start - frameStart) + range.replacement;
      cursor = Math.max(cursor, Math.min(frameEnd, range.end));
      if (range.end > frameEnd) break;
      next += 1;
    }
    placed += text.slice(cursor - frameStart);
    frameStart = frameEnd;
    return { atMs, text: placed };
  });
}

/**
 * How many of `frames` this window keeps: those ending by `limit`, up to the
 * last boundary no range crosses — after a line break if one does — or, when
 * every boundary is crossed, as many as reach `limit`, at least one.
 */
function framesToKeep(frames, ranges, limit) {
  let end = 0;
  let reach = 0;
  let clean = 0;
  let afterLine = 0;
  for (const [index, { text }] of frames.entries()) {
    end += text.length;
    if (end > limit) break;
    reach = index + 1;
    if (ranges.some((range) => range.start < end && range.end > end)) continue;
    clean = index + 1;
    if (text.endsWith("\n")) afterLine = index + 1;
  }
  return afterLine || clean || Math.max(reach, 1);
}

/**
 * Masks the recording at `path` in place.
 * @param {string} path
 * @param {{
 *   redactor: Parameters<typeof maskedRanges>[1]["redactor"],
 *   scan?: Parameters<typeof maskedRanges>[1]["scan"],
 *   fs: {
 *     open: (path: string, flags: "r") => Promise<{ read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>, close: () => Promise<void> }>,
 *     writeFile: (path: string, content: string, options: { encoding: "utf8", mode: number }) => Promise<unknown>,
 *     appendFile: (path: string, content: string, options: { encoding: "utf8" }) => Promise<unknown>,
 *     rename: (from: string, to: string) => Promise<unknown>,
 *     rm: (path: string, options: { force: true }) => Promise<unknown>,
 *   },
 * }} options
 */
export async function maskTerminalRecording(path, { redactor, scan, fs }) {
  const masked = `${path}.masked`;
  try {
    await writeMasked(path, masked, { redactor, scan, fs });
  } catch (error) {
    await fs.rm(masked, { force: true }).catch(() => undefined);
    throw error;
  }
  await fs.rename(masked, path);
}

/** The masked copy of the recording at `path`, written to `masked`. */
async function writeMasked(path, masked, { redactor, scan, fs }) {
  const handle = await fs.open(path, "r");
  try {
    const lines = recordingLines(handle);
    const header = JSON.parse(String((await lines.next()).value ?? ""));
    if (typeof header !== "object" || header === null || Array.isArray(header)) throw new Error("The recording has no header.");
    const columns = typeof header.cols === "number" && header.cols > 0 ? header.cols : DEFAULT_COLUMNS;
    await fs.writeFile(masked, `${JSON.stringify({ ...header, masked: true })}\n`, { encoding: "utf8", mode: 0o600 });
    const decoder = new StringDecoder("utf8");
    let frames = [];
    let held = 0;
    const flush = async (sessionEnds) => {
      const text = frames.map((frame) => frame.text).join("");
      const ranges = await maskedRanges(text, { redactor, columns, scan, sessionEnds });
      const kept = sessionEnds ? frames.length : framesToKeep(frames, ranges, text.length - OVERLAP);
      const placed = placeRanges(frames.slice(0, kept), ranges);
      await fs.appendFile(masked, placed.map(({ atMs, text: part }) => `${JSON.stringify([atMs, "o", Buffer.from(part, "utf8").toString("base64")])}\n`).join(""), { encoding: "utf8" });
      frames = frames.slice(kept);
      held = frames.reduce((total, frame) => total + frame.text.length, 0);
    };
    for await (const line of lines) {
      const frame = outputFrame(line);
      if (!frame) continue;
      const text = decoder.write(frame.bytes);
      frames.push({ atMs: frame.atMs, text });
      held += text.length;
      if (held >= WINDOW + OVERLAP) await flush(false);
    }
    const rest = decoder.end();
    if (rest && frames.length) frames[frames.length - 1].text += rest;
    await flush(true);
  } finally {
    await handle.close();
  }
}

/**
 * The header of the recording at `path` when this pass wrote it (its header
 * says so), or null: a log that is not is read and kept by no one.
 * @param {string} path
 * @param {{ open: (path: string, flags: "r") => Promise<{ read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>, close: () => Promise<void> }> }} fs
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function maskedRecordingHeader(path, fs) {
  let handle;
  try {
    handle = await fs.open(path, "r");
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    const header = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "");
    return typeof header === "object" && header !== null && header.masked === true ? header : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
