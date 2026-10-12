// The exported replay's terminal segments, as pictures: each shell's NDJSON
// recording written back into the console's own renderer (terminal-page.mjs)
// and photographed once per frame of the video, so a segment is a screen
// recording of the Terminal tab at the replay's own frame rate.
//
// A frame at time t shows the screen as it stood at t, all the output written
// at or before t painted, as the console's panel shows it at the same moment:
// a program that redraws faster than the frame rate is seen redrawing, at the
// frame rate. A frame the shell wrote nothing for is the frame before it
// again, a hard link rather than a photograph, so a long quiet stretch costs
// no work and no disk. A shell is never drawn before it has printed: an empty
// grid shows nothing, and a replay's first frame is its thumbnail, so until
// its first output a frame shows the first frame that has it.
//
// The pictures are the frame's own size (PICTURE_ROOM), as the browser's is,
// the grid drawn into the room above the overlay's band (GRID_ROOM) by the
// rule that places the browser's picture (pictureLayout): the band never
// covers a row, and the newest one, at the bottom, stays readable.
//
// The export asks for them through drawTerminalPieces: each terminal piece's
// frames, from the log the finalizer found drawable (recording-finalize.mjs
// decides which shells can be drawn), under a deadline. What the replay shows
// where the drawing fails is the export's to decide (replay-export.mjs).
import { link, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RECORDING_FRAME_RATE } from "@shipbash/contracts/runtime/recording-bounds.mjs";
import { GRID_ROOM, PICTURE_ROOM, pictureLayout } from "@shipbash/contracts/runtime/recording-overlay.mjs";

import { readTerminalLog } from "./terminal-log.mjs";
import { openTerminalPage } from "./terminal-page.mjs";

const FRAME_MS = 1_000 / RECORDING_FRAME_RATE;
/** The frames' file names, as ffmpeg's image2 demuxer reads the sequence back. */
export const TERMINAL_FRAME_PATTERN = "%06d.png";

function frameFile(directory, index) {
  return join(directory, `${String(index).padStart(6, "0")}.png`);
}

/** How many frames a piece of the replay takes: its last, partial frame included. */
function frameCount(piece) {
  return Math.ceil((piece.endMs - piece.startMs) / FRAME_MS);
}

/**
 * Up to when a frame at `atMs` paints the shell's output: `atMs` itself, or,
 * while nothing is written yet, the first frame on the same grid at or after
 * the shell's first output (`firstOutputMs`, null for a shell that never
 * printed), so no frame shows the empty grid before it.
 */
function paintedUntil(atMs, firstOutputMs, written) {
  if (written || firstOutputMs === null || firstOutputMs <= atMs) return atMs;
  return atMs + Math.ceil((firstOutputMs - atMs) / FRAME_MS) * FRAME_MS;
}

/**
 * One session's pieces, each frame photographed or linked to the frame before
 * it. The output is written in one forward pass: what the shell wrote between
 * two of its pieces is written before the second one's first frame.
 */
async function renderSession({ page, recording, pieces, clock, directory, signal }) {
  const { startedAt, cols, rows, entries } = recording;
  const size = await page.open(cols, rows);
  const grid = pictureLayout(size, GRID_ROOM);
  await page.place(grid.x, grid.y, grid.width / size.width, grid.height / size.height);
  const firstOutputMs = entries.length > 0 ? clock(startedAt + entries[0].atMs) : null;
  let next = 0;
  let last = null;
  for (const { piece, first } of pieces) {
    for (let frame = 0; frame < frameCount(piece); frame += 1) {
      signal?.throwIfAborted();
      const untilMs = paintedUntil(piece.startMs + frame * FRAME_MS, firstOutputMs, next > 0);
      const chunks = [];
      while (next < entries.length && clock(startedAt + entries[next].atMs) <= untilMs) chunks.push(entries[next++].data);
      const file = frameFile(directory, first + frame);
      if (last !== null && chunks.length === 0) {
        await link(last.file, file);
        continue;
      }
      if (chunks.length > 0) await page.write(chunks);
      const data = await page.screenshot();
      if (last?.data === data) {
        await link(last.file, file);
        continue;
      }
      await writeFile(file, Buffer.from(data, "base64"), { mode: 0o600 });
      last = { data, file };
    }
  }
}

/**
 * Every terminal piece of the replay as one numbered sequence of frames in
 * `directory`, at the replay's frame rate, the pieces back to back in the
 * order given; answers where each piece starts in that sequence, in
 * milliseconds of it.
 *
 * `pieces` are on the video's frame grid and each names its session;
 * `recordings` holds every such session's parsed log; `clock` is the
 * recording's own (recording-clock.mjs), which places each chunk of output in
 * the walk it was written in. Aborting `signal` stops the render: the page is
 * closed at once, which ends a command it is stuck in, and the render throws
 * the signal's reason.
 * @param {{ pieces: Array<{ startMs: number, endMs: number, sessionId: string }>, recordings: Map<string, NonNullable<ReturnType<typeof import("./terminal-log.mjs").parseTerminalLog>>>, clock: (epochMs: number) => number, directory: string, signal?: AbortSignal, openPage?: typeof openTerminalPage }} input
 * @returns {Promise<number[]>}
 */
export async function renderTerminalFrames({ pieces, recordings, clock, directory, signal, openPage = openTerminalPage }) {
  const firsts = [];
  let frames = 0;
  for (const piece of pieces) {
    firsts.push(frames);
    frames += frameCount(piece);
  }
  const page = await openPage(PICTURE_ROOM);
  const stop = () => void page.close();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    for (const [sessionId, recording] of recordings) {
      const own = pieces.flatMap((piece, index) => (piece.sessionId === sessionId ? [{ piece, first: firsts[index] }] : []));
      if (own.length > 0) await renderSession({ page, recording, pieces: own, clock, directory, signal });
    }
  } catch (error) {
    throw signal?.aborted ? signal.reason : error;
  } finally {
    signal?.removeEventListener("abort", stop);
    await page.close();
  }
  return firsts.map((first) => first * FRAME_MS);
}

/** The drawable shells' logs, parsed for the frames; one that can no longer be read fails the render. */
async function terminalRecordings(logs) {
  const recordings = new Map();
  for (const [sessionId, path] of Object.entries(logs)) {
    const recording = await readTerminalLog(path);
    if (!recording) throw new Error(`The terminal log of ${sessionId} could not be read again.`);
    recordings.set(sessionId, recording);
  }
  return recordings;
}

/**
 * How long the terminal's frames may take to draw: half the terminal's own
 * length on screen, never under two minutes (a cold Sandbox's first Chromium
 * can take its launch attempts' full minute and a half) and never over five,
 * half the encode's own command timeout. Measured on two CPUs: seven minutes
 * of terminal redrawn every frame drew in 38–45 s.
 * @param {Array<{ startMs: number, endMs: number }>} pieces
 */
function terminalRenderDeadlineMs(pieces) {
  const terminalMs = pieces.reduce((total, piece) => total + piece.endMs - piece.startMs, 0);
  return Math.min(300_000, Math.max(120_000, terminalMs / 2));
}

/**
 * The terminal pieces' frames, drawn into `directory` from `logs` (session to
 * log path); answers where each piece starts in the frames, in order. A
 * renderer that cannot be launched, dies partway, or outlasts its deadline
 * throws why. The render is told to stop at the deadline (it closes its
 * browser), and nothing waits for it past the deadline either way.
 * @param {{ pieces: Array<{ startMs: number, endMs: number, sessionId: string }>, logs: Record<string, string>, clock: (epochMs: number) => number, directory: string, renderTerminal: typeof renderTerminalFrames }} input
 * @returns {Promise<number[]>}
 */
export async function drawTerminalPieces({ pieces, logs, clock, directory, renderTerminal }) {
  const deadlineMs = terminalRenderDeadlineMs(pieces);
  const deadline = new AbortController();
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const reason = new Error(`The terminal render passed its ${String(deadlineMs / 1_000)} s deadline.`);
      deadline.abort(reason);
      reject(reason);
    }, deadlineMs);
  });
  const rendering = terminalRecordings(logs)
    .then((recordings) => renderTerminal({ pieces, recordings, clock, directory, signal: deadline.signal }));
  rendering.catch(() => {});
  try {
    return await Promise.race([rendering, expired]);
  } catch (error) {
    throw deadline.signal.aborted ? deadline.signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}
