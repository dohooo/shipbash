// The exported replay: one continuous video that follows the agent.
//
// A case run leaves two kinds of evidence behind — a screen recording of the
// browser and an NDJSON log of every shell it opened — and a reader who wants
// to know what happened has to watch one and read the other. This assembles
// them into a single file, cut in the agent's own order: the browser where the
// agent was in the browser, a rendered terminal where it was in the terminal,
// hard cuts between them, the cursor burned in throughout. It is also the
// video that leaves the console — a Slack thread, a download — where no
// player draws the chapters, the agent's points or its narration, so it
// carries the overlay the console's preview shows (recording-overlay.mjs),
// burned in, and plays on the paced timeline the player uses: every idle
// stretch sped up by its rate.
//
// It is one encode, not two. The cursor and the overlay are subtitle
// overlays (cursor-overlay.mjs, overlay-ass.mjs) and the terminal is a
// sequence of frames photographed from the console's own renderer
// (terminal-frames.mjs), so all of it rides one filter graph: the browser
// video with the cursor over it, the terminal's frames, each laid out in the
// frame (pictureLayout), trimmed per piece, sped up by the piece's rate, and
// concatenated; the overlay is drawn over the joined result, on its own
// timeline. A run that never opened a shell has only browser pieces and a
// walk that never left one only terminal pieces; the graph is built from
// whichever sources the pieces use.
// The encode is H.264 in MP4, the one video every surface the replay is
// handed to plays inline.
//
// Nothing here may reach the verdict. The export runs beside teardown, under
// the finalizer's own command timeout, and a failure costs an artifact, not a
// case.
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { attentionSegments } from "@shipbash/contracts/runtime/attention-track.mjs";
import { CASE_REPLAY_FILE } from "@shipbash/contracts/runtime/browser-recording-format.mjs";
import { RECORDING_FRAME_RATE } from "@shipbash/contracts/runtime/recording-bounds.mjs";
import { recordingClock } from "@shipbash/contracts/runtime/recording-clock.mjs";
import { RECORDING_OVERLAY, pictureLayout } from "@shipbash/contracts/runtime/recording-overlay.mjs";
import { recordingOverlayFontFiles } from "@shipbash/contracts/runtime/recording-overlay-font-files.mjs";

import { BROWSER_RECORDING_ENCODE_ARGS, BROWSER_RECORDING_FASTSTART_ARGS } from "./browser-recording.mjs";
import { cursorAssDocument, cursorOverlayEvents } from "./cursor-overlay.mjs";
import { overlayAssDocument } from "./overlay-ass.mjs";
import { filterPath, nonEmptyFile, runRecordingCommand } from "./recording-command.mjs";
import { pacedOverlayRecording, pacedSegments, replayCut } from "./replay-timeline.mjs";
import { TERMINAL_FRAME_PATTERN, drawTerminalPieces, renderTerminalFrames } from "./terminal-frames.mjs";

/** A keyframe every two seconds, so a player seeks without decoding from the start. */
const REPLAY_KEYFRAME_FRAMES = RECORDING_FRAME_RATE * 2;
/**
 * The timebase every piece is timed in: a millisecond. At the frame rate's
 * own 1/10 s, dividing a piece's timestamps by its rate rounds them to whole
 * tenths, and over a long walk with many idle stretches the video ends
 * seconds before the overlay drawn on the paced timeline does.
 */
const REPLAY_TIMEBASE = "1/1000";
function seconds(ms) {
  return (Math.max(0, ms) / 1_000).toFixed(3);
}

/** A piece re-based to zero, and sped up by its rate when it is an idle stretch. */
function timestamps(rate) {
  return rate > 1 ? `setpts=(PTS-STARTPTS)/${String(rate)}` : "setpts=PTS-STARTPTS";
}

/**
 * A piece cut out of its source: the stretch `fromMs`..`toMs` at its rate,
 * or, for a piece `held` (a shell the render could not draw), the source's
 * frame at `fromMs` held for as long as the stretch plays.
 */
function cutPiece(piece) {
  if (!piece.held) return `trim=start=${seconds(piece.fromMs)}:end=${seconds(piece.toMs)},${timestamps(piece.rate)}`;
  const frameMs = 1_000 / RECORDING_FRAME_RATE;
  const playsMs = (piece.toMs - piece.fromMs) / piece.rate;
  return `trim=start=${seconds(piece.fromMs)}:end=${seconds(piece.fromMs + frameMs)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${seconds(playsMs - frameMs)}`;
}

/**
 * The filters that put each source's picture into the frame: the browser's
 * video, its cursor drawn first, scaled into the rectangle the shared layout
 * gives it in the frame, on a black backdrop where it does not fill it. The
 * terminal's frames are the frame already (PICTURE_ROOM, as
 * terminal-frames.mjs draws them), so they take none.
 * @returns {Record<string, string[]>}
 */
function placements(cursorPath, video) {
  const { width, height } = RECORDING_OVERLAY.frame;
  const browser = pictureLayout(video);
  return {
    browser: [
      `ass=${filterPath(cursorPath)}`,
      `fps=${String(RECORDING_FRAME_RATE)}`,
      `scale=${String(browser.width)}:${String(browser.height)}:flags=lanczos`,
      `pad=${String(width)}:${String(height)}:${String(browser.x)}:${String(browser.y)}:black`,
    ],
    terminal: [],
  };
}

/**
 * The filter graph, as one string.
 *
 * Each source a piece is cut from is placed once and then `split` into as
 * many copies as it has pieces, because a filter output can only be consumed
 * once; a source no piece uses is not in the graph at all. Every piece is
 * trimmed out of its source — at `fromMs`..`toMs`, the source's own clock —
 * re-based to zero and sped up by its rate, and `concat` joins them in order,
 * which is what makes the cuts hard. The joined video is resampled to the
 * recording's frame rate, which drops the frames a sped-up piece crowds in,
 * and the overlay is drawn over it with libass's simple shaper from the
 * overlay's own fonts directory.
 * @param {{ pieces: Array<{ surface: string, fromMs: number, toMs: number, rate: number, held?: boolean }>, cursorPath: string, overlayPath: string, fontsPath: string, video: { width: number, height: number } }} input
 */
function replayFilterGraph({ pieces, cursorPath, overlayPath, fontsPath, video }) {
  const placed = placements(cursorPath, video);
  const sources = [
    { surface: "browser", input: "0:v", prefix: "b" },
    { surface: "terminal", input: "1:v", prefix: "t" },
  ];
  const chains = [];
  const taken = new Map();
  for (const { surface, input, prefix } of sources) {
    const count = pieces.filter((piece) => piece.surface === surface).length;
    if (count === 0) continue;
    const labels = Array.from({ length: count }, (_, index) => `[${prefix}${String(index)}]`).join("");
    const filters = [...placed[surface], "format=yuv420p", "setsar=1", `settb=${REPLAY_TIMEBASE}`, `split=${String(count)}`];
    chains.push(`[${input}]${filters.join(",")}${labels}`);
    taken.set(surface, { prefix, next: 0 });
  }
  const cuts = pieces.map((piece, index) => {
    const source = taken.get(piece.surface);
    chains.push(`[${source.prefix}${String(source.next++)}]${cutPiece(piece)}[s${String(index)}]`);
    return `[s${String(index)}]`;
  });
  chains.push(`${cuts.join("")}concat=n=${String(cuts.length)}:v=1:a=0[joined]`);
  chains.push(`[joined]fps=${String(RECORDING_FRAME_RATE)},ass=${filterPath(overlayPath)}:fontsdir=${filterPath(fontsPath)}:shaping=simple,format=yuv420p[replay]`);
  return chains.join(";");
}

/**
 * The ffmpeg invocation. The second input exists only when a terminal piece
 * does: the terminal's frames, read back as a sequence at the replay's frame
 * rate. The encode is the recorder's own H.264 line, at the overlay's frame
 * size, with the index at the front of the file so a player starts on its
 * first range request.
 * @param {{ videoPath: string, terminalFramesPath: string, cursorPath: string, overlayPath: string, fontsPath: string, pieces: Array<{ surface: string, fromMs: number, toMs: number, rate: number, held?: boolean }>, video: { width: number, height: number }, outputPath: string }} input
 */
function replayExportArgs({
  videoPath,
  terminalFramesPath,
  cursorPath,
  overlayPath,
  fontsPath,
  pieces,
  video,
  outputPath,
}) {
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", videoPath];
  if (pieces.some((piece) => piece.surface === "terminal")) {
    args.push("-framerate", String(RECORDING_FRAME_RATE), "-i", terminalFramesPath);
  }
  args.push(
    "-filter_complex", replayFilterGraph({ pieces, cursorPath, overlayPath, fontsPath, video }),
    "-map", "[replay]",
    "-an",
    ...BROWSER_RECORDING_ENCODE_ARGS,
    "-g", String(REPLAY_KEYFRAME_FRAMES),
    ...BROWSER_RECORDING_FASTSTART_ARGS,
    outputPath,
  );
  return args;
}

/**
 * Each piece with the stretch of its own source it is cut from: a browser
 * piece at its place in the recording, a terminal piece where the terminal's
 * frames put it (`starts`, one per terminal piece, in order).
 */
function sourcedPieces(pieces, starts) {
  let terminal = 0;
  return pieces.map((piece) => {
    const fromMs = piece.surface === "terminal" ? starts[terminal++] : piece.startMs;
    return { ...piece, fromMs, toMs: fromMs + piece.endMs - piece.startMs };
  });
}

/**
 * The replay's pieces with their terminal frames drawn (terminal-frames.mjs drawTerminalPieces).
 * A drawing that fails costs the terminal pieces, not the replay, and the
 * reason is reported once: each keeps its place and its pace and shows the
 * browser as it stood where the piece begins, held, since the recording was
 * paced for a shell there and the browser's own footage would race through
 * at the shell's idle rate. This is the one surface the export decides; every
 * other is the finalizer's.
 */
async function drawnPieces(pieces, { logs, clock, directory, renderTerminal, reportTerminalFailure }) {
  const terminal = pieces.filter((piece) => piece.surface === "terminal");
  if (terminal.length === 0) return sourcedPieces(pieces, []);
  try {
    return sourcedPieces(pieces, await drawTerminalPieces({ pieces: terminal, logs, clock, directory, renderTerminal }));
  } catch (error) {
    reportTerminalFailure(error);
    return sourcedPieces(pieces.map((piece) => (piece.surface === "terminal" ? { ...piece, surface: "browser", held: true } : piece)), []);
  }
}

/**
 * The overlay's face files, alone in a directory of the export's own: libass
 * loads every file in the directory it is given, and the package's font
 * directory also holds the licence, which it cannot read as a font.
 */
async function overlayFontsDirectory(workspace) {
  const fonts = join(workspace, "fonts");
  await mkdir(fonts);
  await Promise.all(recordingOverlayFontFiles().map((file) => copyFile(file, join(fonts, basename(file)))));
  return fonts;
}

/**
 * A finalized recording (recording-finalize.mjs) rendered as its replay: a
 * Journey's (suite-runner/recording-output.mjs) and a walk's
 * (activity-runner/walk-recording.mjs), whole or cut to the Journeys it
 * marked. Answers where the replay landed, or null when there was nothing to
 * render. Throws only what the caller is expected to swallow; a terminal
 * renderer's failure is handed to `reportTerminalFailure` instead.
 * `workspaceRoot` is where the export's scratch goes: beside the case
 * directory unless the caller names a directory of its own on the same file
 * system (a walk's output root, whose parent it may not write to). `keep`, the
 * Journeys a walk marked as the finalizer placed them on the video
 * (`journeys`), cuts the replay to them; `fileName` is the file it lands in.
 * The surfaces and shells are the playback document's own: the finalizer
 * decided them, and which shells can be drawn (`terminalLogs`), before it
 * paced the recording.
 * @param {{ videoPath: string, playback: import("./recording-playback.mjs").Playback, durationMs: number, width: number, height: number, terminalLogs?: Record<string, string> }} recording
 * @param {{ caseDirectory: string, workspaceRoot?: string, fileName?: string, keep?: ReadonlyArray<{ title: string, startMs: number, endMs: number }>, runCommand?: Function, renderTerminal?: typeof renderTerminalFrames, reportTerminalFailure?: (error: unknown) => void }} into
 */
export async function exportFinalizedReplay({ videoPath, playback, durationMs, width, height, terminalLogs = {} }, {
  caseDirectory,
  workspaceRoot = dirname(caseDirectory),
  fileName = CASE_REPLAY_FILE,
  keep = [],
  runCommand = runRecordingCommand,
  renderTerminal = renderTerminalFrames,
  reportTerminalFailure = () => {},
}) {
  const video = { width, height };
  const segments = attentionSegments(playback.attention, durationMs);
  if (segments.length === 0 || !(video.width > 0) || !(video.height > 0)) return null;
  const clock = recordingClock(playback.anchors, durationMs);
  const outputPath = join(caseDirectory, fileName);
  await rm(outputPath, { force: true });
  // Beside the case directory, not inside it — the artifact walk reads the
  // case directory whole, and scratch files would ride out as evidence — and
  // on its file system, so the finished replay moves in by one atomic rename.
  // Never the Sandbox's /tmp, a 1 GB tmpfs a long walk's encode can fill.
  const workspace = await mkdtemp(join(workspaceRoot, `.${basename(caseDirectory)}-replay-`));
  try {
    const terminalDirectory = join(workspace, "terminal");
    await mkdir(terminalDirectory);
    const cut = replayCut(playback.speedSegments, segments, durationMs, keep);
    const pieces = await drawnPieces(pacedSegments(cut.segments, cut.timeline), {
      logs: terminalLogs, clock, directory: terminalDirectory, renderTerminal, reportTerminalFailure,
    });
    const cursorPath = join(workspace, "cursor.ass");
    const overlayPath = join(workspace, "overlay.ass");
    await writeFile(cursorPath, cursorAssDocument(
      cursorOverlayEvents({ pointers: playback.pointers, durationMs, video }),
      video,
    ), { mode: 0o600 });
    await writeFile(overlayPath, overlayAssDocument(pacedOverlayRecording(playback, durationMs, cut.timeline, keep)), { mode: 0o600 });
    const fontsPath = await overlayFontsDirectory(workspace);
    // Encoded beside the overlays, and in the case directory only once it is
    // whole: an encode killed halfway leaves no replay to be filed as one.
    const encodedPath = join(workspace, fileName);
    await runCommand("ffmpeg", replayExportArgs({
      videoPath,
      terminalFramesPath: join(terminalDirectory, TERMINAL_FRAME_PATTERN),
      cursorPath,
      overlayPath,
      fontsPath,
      pieces,
      video,
      outputPath: encodedPath,
    }));
    if (!(await nonEmptyFile(encodedPath))) {
      throw new Error("The replay export produced an empty video.");
    }
    await rename(encodedPath, outputPath);
    return outputPath;
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}
