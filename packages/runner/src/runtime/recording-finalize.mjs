// Turning the round's raw recording segments into the one video and its
// playback document, and for a Journey the poster and document file the
// console reads beside it. Everything here
// shells out to ffmpeg; browser-recording.mjs holds the geometry and the
// encoder lines it feeds on, recording-playback.mjs the document and
// smart-pacing.mjs its idle stretches.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { BROWSER_RECORDING_METADATA_FILE } from "@shipbash/contracts/runtime/browser-recording-format.mjs";
import { MAX_RECORDING_SPEED_SEGMENTS } from "@shipbash/contracts/runtime/recording-bounds.mjs";

import {
  BROWSER_RECORDING_ENCODE_ARGS,
  BROWSER_RECORDING_FASTSTART_ARGS,
  parseRecordingMetadata,
  recordingOutputPaths,
} from "./browser-recording.mjs";
import { nonEmptyFile, runRecordingCommand } from "./recording-command.mjs";
import { heldJourneys } from "./recording-journeys.mjs";
import { withinWalkShares } from "./recording-walks.mjs";
import { buildRecordingPlaybackMetadata, maskPlaybackText } from "./recording-playback.mjs";
import { detectSmartPlaybackSegments } from "./smart-pacing.mjs";
import { terminalLogDrawable } from "./terminal-log.mjs";

function concatFileLine(path) {
  if (/\r|\n/u.test(path)) throw new Error("Browser recording path contains a newline.");
  return `file '${path.replaceAll("'", "'\\''")}'`;
}

async function probeVideo(path, runCommand) {
  const probe = await runCommand("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json",
    path,
  ]);
  return parseRecordingMetadata(JSON.parse(probe.stdout));
}

/**
 * Segments are fragmented MP4, which is what survives a killed encoder but is
 * not what a player should be handed. One segment and several take the same
 * path: remux into an ordinary faststart MP4. The copy decodes nothing, so
 * the single-segment case costs no more than the file copy it replaces.
 */
async function consolidateSegments(segmentPaths, videoPath, runCommand) {
  await mkdir(dirname(videoPath), { recursive: true });
  await rm(videoPath, { force: true });

  const manifestPath = `${videoPath}.concat.txt`;
  await writeFile(
    manifestPath,
    `${segmentPaths.map(concatFileLine).join("\n")}\n`,
    { mode: 0o600 },
  );
  try {
    try {
      // Every segment came off the same encoder line, so the streams join
      // without being decoded.
      await runCommand("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", manifestPath,
        "-c", "copy", ...BROWSER_RECORDING_FASTSTART_ARGS, videoPath,
      ]);
    } catch {
      await runCommand("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", manifestPath,
        "-an", ...BROWSER_RECORDING_ENCODE_ARGS, ...BROWSER_RECORDING_FASTSTART_ARGS, videoPath,
      ]);
    }
  } finally {
    await rm(manifestPath, { force: true });
  }
}

/** A segment the recorder never wrote is not a failure: that walk is simply not on the video. */
async function availableSegments(segments) {
  const available = [];
  for (const segment of segments) {
    if (await nonEmptyFile(segment.path)) available.push(segment);
  }
  return available;
}

/** Each segment with its own video's length, which places it on the joined video. */
async function probeSegments(segments, runCommand) {
  const probed = [];
  for (const segment of segments) {
    probed.push({ ...segment, ...(await probeVideo(segment.path, runCommand)) });
  }
  return probed;
}

/** The last frame, so the console has a still to show before playback starts. */
async function renderPoster(videoPath, posterPath, runCommand) {
  try {
    await rm(posterPath, { force: true });
    await runCommand("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-sseof", "-0.1", "-i", videoPath,
      "-frames:v", "1", "-q:v", "2", posterPath,
    ]);
    if (await nonEmptyFile(posterPath)) return posterPath;
  } catch {
    await rm(posterPath, { force: true });
  }
  return null;
}

/**
 * A captured recording (recording-capture.mjs Recording) assembled into its
 * video in `outputDirectory` and its playback document. `fallback` is the
 * words it opens and closes on (recording-playback.mjs FALLBACK_NARRATION).
 * `redactor` is required: the run's own (runner-redaction.mjs), holding every
 * secret the run registered, which masks the playback document's words
 * (recording-playback.mjs maskPlaybackText). No recording is finalized
 * without it. Which shells can be drawn is decided here, once, before
 * pacing, from the logs the lane named for them (drawableTerminalLogs), and
 * the finalized recording names those logs (`terminalLogs`) for its export.
 * So too where the Journeys a walk marked lie on the video, on the frame grid,
 * each kept until the lines said in it are read (`journeys`,
 * recording-journeys.mjs heldJourneys), which the export cuts to.
 * @param {import("./recording-capture.mjs").Recording} recording
 * @param {{
 *   outputDirectory: string,
 *   fallback: Parameters<typeof buildRecordingPlaybackMetadata>[1]["fallback"],
 *   redactor: Parameters<typeof maskPlaybackText>[1]["redactor"],
 *   runCommand?: typeof runRecordingCommand,
 * }} assembly
 */
export async function finalizeBrowserRecording(recording, { outputDirectory, fallback, redactor, runCommand = runRecordingCommand }) {
  const available = await availableSegments(recording.segments);
  if (available.length === 0) return null;

  const segments = await probeSegments(available, runCommand);

  const { videoPath } = recordingOutputPaths(outputDirectory);
  await consolidateSegments(available.map((segment) => segment.path), videoPath, runCommand);
  if (!(await nonEmptyFile(videoPath))) {
    throw new Error("Browser recording finalization produced an empty video.");
  }

  // The remuxed file is the authority on duration: a segment whose encoder was
  // killed carries only the fragments that reached disk, and the join is what
  // says how much of the round actually survived.
  const metadata = await probeVideo(videoPath, runCommand);
  const terminalLogs = await drawableTerminalLogs(recording.terminalSessions, recording.attention);
  const built = buildRecordingPlaybackMetadata({ ...recording, segments }, { fallback, terminalLogs, durationMs: metadata.durationMs });
  const masked = await maskPlaybackText(built.playback, { redactor });
  // A video smart pacing cannot read plays at 1x throughout.
  const idle = await detectSmartPlaybackSegments(videoPath, metadata.durationMs, masked, runCommand).catch(() => []);
  // The bound is the document's, shared between its walks, as the builder shares the others.
  const playback = { ...masked, speedSegments: withinWalkShares(idle, built.walks, (stretch) => stretch.startMs, MAX_RECORDING_SPEED_SEGMENTS) };

  for (const segment of available) {
    await rm(segment.path, { force: true });
  }
  return {
    videoPath, playback, width: metadata.width, height: metadata.height, durationMs: metadata.durationMs, terminalLogs,
    journeys: heldJourneys(built.journeys, masked.cues, metadata.durationMs),
  };
}

/**
 * The shells the replay can draw, by session, each with its log: of those the
 * capture named for the agent's terminal moves, in the order it named them,
 * each whose log the lane wrote (`logPath`) is masked with a clock and a grid,
 * judged from its header (terminal-log.mjs terminalLogDrawable): only the
 * export reads a log whole.
 * A shell with none is shown as the browser: a frozen page is honest, a black
 * rectangle is not.
 * @param {import("./recording-capture.mjs").Recording["terminalSessions"]} sessions
 * @param {import("./recording-capture.mjs").Recording["attention"]} attention
 * @returns {Promise<Record<string, string>>}
 */
async function drawableTerminalLogs(sessions, attention) {
  /** @type {Record<string, string>} */
  const drawable = {};
  const named = new Set(attention.flatMap((point) => (point.surface === "terminal" && point.sessionId ? [point.sessionId] : [])));
  for (const sessionId of named) {
    const logPath = sessions.find((session) => session.sessionId === sessionId)?.logPath;
    if (logPath && await terminalLogDrawable(logPath)) drawable[sessionId] = logPath;
  }
  return drawable;
}

/**
 * What the console reads beside a finalized Journey's video, in its
 * `outputDirectory`: the poster and the playback document. A walk's
 * recording is read by no player and leaves neither.
 * @param {NonNullable<Awaited<ReturnType<typeof finalizeBrowserRecording>>>} recording
 * @param {string} outputDirectory
 * @param {typeof runRecordingCommand} [runCommand]
 */
export async function fileBrowserRecording(recording, outputDirectory, runCommand = runRecordingCommand) {
  const { videoPath, playback, width, height, durationMs } = recording;
  const { posterPath } = recordingOutputPaths(outputDirectory);
  const retainedPosterPath = await renderPoster(videoPath, posterPath, runCommand);
  await writeFile(
    join(outputDirectory, BROWSER_RECORDING_METADATA_FILE),
    `${JSON.stringify({ schemaVersion: 3, width, height, durationMs, poster: retainedPosterPath !== null, playback })}\n`,
    { mode: 0o600 },
  );
  return { ...recording, posterPath: retainedPosterPath };
}
