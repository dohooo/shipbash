// A walk's screen recording, made only when the host asked for one: the
// Activity's input says `recordScreen`, which the host sets on every walk a
// conversation starts and on nothing else (control-plane store/walks.ts).
//
// It is a Journey's recording made the same way (suite-runner/case-attempt.mjs,
// recording-output.mjs), by the same capture (recording-capture.mjs): the
// stream recorder joins this leg's sidecar beside the live viewer, the walk's
// own narration is its captions — publish_narration, which the video row
// gives a leg that records — and its pointers, its moves between the browser
// and the terminal and the Journeys it marks are forwarded to the capture as
// they happen. Once the leg has let its browser go, the video is
// finalized and exported as a case run's replay is (recording-finalize.mjs,
// replay-export.mjs) — idle stretches sped up, the chapters' progress bar and
// the captions burned in — into the output root as `case-replay.mp4`, where
// the host keeps it for the conversation's thread
// (control-plane evidence-retention/activity.ts). It is evidence,
// never the walk's result: every way it fails is a warning.
//
// The agent marks where each Journey it walks starts and ends (mark_journey).
// A walk that marked any is sent cut to them, one chapter per Journey opening
// on its first step with what the walk said before it, and its whole replay
// is kept beside it as `walk-replay.mp4`; one that marked none, or whose cut
// cannot be made, is sent whole, and says so.
//
// A runner process owns one Activity, so the recording is this module's own,
// as the step evidence recorder is (evidence-capture.mjs).
import { join } from "node:path";

import { WALK_REPLAY_FILE } from "@shipbash/contracts/runtime/browser-recording-format.mjs";

import { recordingSegmentPath } from "../browser-recording.mjs";
import { createRecordingCapture } from "../recording-capture.mjs";
import { finalizeBrowserRecording } from "../recording-finalize.mjs";
import { startNarrationReader } from "../recording-narration.mjs";
import { FALLBACK_NARRATION } from "../recording-playback.mjs";
import { exportFinalizedReplay } from "../replay-export.mjs";

import { NARRATION_PATH, OUTPUT_ROOT, activityDeadlineRemainingMs } from "./environment.mjs";
import { redactActivityValue, redactor, safeError } from "./redaction.mjs";
import { emit, pollCancelRequested } from "./state.mjs";

/** The raw recording's own directory: the export lands beside it, in the output root the host reads. */
const RECORDING_DIRECTORY = join(OUTPUT_ROOT, "recording");
/**
 * Less time than this before the Sandbox is deleted leaves no room for the
 * export and the host's share after it: the leg already closed early to keep
 * its own result (environment.mjs WALL_CLOCK_RESERVE_MS), and the export must
 * not take that from it.
 */
const EXPORT_RESERVE_MS = 4 * 60_000;

/** The walk's capture, once its recorder started. @type {null | ReturnType<typeof createRecordingCapture>} */
let recording = null;

function warn(stage, error, label = "The walk's screen recording could not be kept") {
  emit("warning", label, {
    safeData: { category: "evidence", event: "walk_recording_failed", stage, message: safeError(error) },
  });
}

/** The owner is sent the whole walk: it marked no Journey, or its Journeys could not be cut out (`error`). */
function sentWhole(error) {
  const label = error
    ? "The walk's Journeys could not be cut out of its recording, so all of it is sent"
    : "The walk marked no Journey, so all of its recording is sent";
  emit("warning", label, {
    safeData: { category: "evidence", event: "walk_recording_unmarked", ...(error ? { message: safeError(error) } : {}) },
  });
}

/** Whether the Sandbox's deadline leaves room for an export and the host's share after it. */
function exportRoom() {
  const remainingMs = activityDeadlineRemainingMs();
  return remainingMs === null || remainingMs >= EXPORT_RESERVE_MS;
}

/** Joins the recorder to the sidecar on `upstreamPort`, its captions timed from its first frame (recording-capture.mjs). */
export async function startWalkRecording({ upstreamPort, terminalLane }) {
  const capture = createRecordingCapture({
    outputPath: recordingSegmentPath(RECORDING_DIRECTORY),
    redact: redactActivityValue,
    terminalLane: () => terminalLane,
  });
  try {
    await capture.start({ upstreamPort });
    recording = capture;
  } catch (error) {
    warn("start", error);
  }
}

/**
 * The walk's subtitles for one agent turn, each a caption where it was said:
 * read off the narration channel its publish_narration writes, and nothing
 * for a leg that records no screen. Like the video, a reader that fails is a
 * warning, never the turn's failure.
 * @returns {Promise<{ stop(): Promise<void> }>}
 */
export async function startWalkNarration() {
  const idle = { stop: async () => {} };
  if (!recording) return idle;
  const failed = (error) => warn("narration", error, "The walk's subtitles could not be kept");
  try {
    const reader = await startNarrationReader(NARRATION_PATH, (cue) => recording?.caption(cue));
    return { stop: () => reader.stop().then(() => undefined, failed) };
  } catch (error) {
    failed(error);
    return idle;
  }
}

/** One pointer the browser proxy published (activity-evidence.mjs), as it is read. */
export function pointWalkRecording(pointer) {
  recording?.point(pointer);
}

/**
 * One completed browser or terminal call, `ms` long, by its tool call id
 * (pi's, or Jev's `jev:<n>`).
 * @param {string} name @param {unknown} args @param {number} ms @param {string} actionId
 */
export function noteWalkRecordingAction(name, args, ms, actionId) {
  recording?.action({ tool: name, arguments: args, actionId, ms });
}

/**
 * One edge of a Journey the walk marked (mark_journey), as the runner reads
 * it. The tool allows one Journey open at a time.
 * @param {{ edge: "start" | "end", title: string }} mark
 */
export function markWalkRecording({ edge, title }) {
  recording?.mark({ edge, title });
}

/** The recorder's own stop, before the sidecar whose frames it drains closes. */
export async function stopWalkRecording() {
  if (!recording) return;
  await recording.stop().catch((error) => warn("stop", error));
}

const TOO_LATE = "Too little time was left before the Sandbox's deadline to export it.";

/**
 * The replays a finalized walk leaves in the output root. Marked Journeys
 * (the finalizer placed them on the video: `journeys`): the cut first, as
 * `case-replay.mp4`, because it is what is sent, then the whole walk as
 * `walk-replay.mp4` if the deadline still allows. None placed, or a cut that
 * fails while the deadline still allows: the whole walk as
 * `case-replay.mp4`; a walk that `marked` Journeys the finalizer could not
 * place (its recording has no clock) says so.
 * @param {NonNullable<Awaited<ReturnType<typeof finalizeBrowserRecording>>>} finalized
 * @param {boolean} marked
 */
async function exportReplays(finalized, marked) {
  const { journeys } = finalized;
  const into = {
    // The output root, where the host collects the replays.
    caseDirectory: OUTPUT_ROOT,
    // Its scratch inside the root too: the root's parent is not the walk's to write in.
    workspaceRoot: OUTPUT_ROOT,
    // The replay still goes out, with the browser where the shell would be.
    reportTerminalFailure: (error) => warn("terminal", error),
  };
  if (journeys.length === 0) {
    sentWhole(marked ? new Error("A recording with no clock cannot be cut to the Journeys the walk marked.") : null);
    await exportFinalizedReplay(finalized, into);
    return;
  }
  try {
    await exportFinalizedReplay(finalized, { ...into, keep: journeys });
  } catch (error) {
    // The cut may have spent the room the whole walk's export needs.
    if (!exportRoom()) {
      warn("cut", error, "The walk's Journeys could not be cut out of its recording");
      warn("export", new Error(TOO_LATE));
      return;
    }
    sentWhole(error);
    await exportFinalizedReplay(finalized, into);
    return;
  }
  if (!exportRoom()) {
    warn("full_walk", new Error(TOO_LATE), "The walk's full recording could not be kept");
    return;
  }
  await exportFinalizedReplay(finalized, { ...into, fileName: WALK_REPLAY_FILE })
    .catch((error) => warn("full_walk", error, "The walk's full recording could not be kept"));
}

/**
 * The video finalized and exported into the output root, once the leg has
 * let its browser go. A walk the owner stopped is not kept waiting on it, and
 * one too close to its Sandbox's deadline goes without. Never throws.
 */
export async function exportWalkRecording() {
  const made = recording;
  recording = null;
  if (!made || pollCancelRequested()) return;
  if (!exportRoom()) {
    warn("export", new Error(TOO_LATE));
    return;
  }
  try {
    const walk = await made.recorded();
    const finalized = await finalizeBrowserRecording(walk, { outputDirectory: RECORDING_DIRECTORY, fallback: FALLBACK_NARRATION.walk, redactor });
    if (!finalized) return;
    await exportReplays(finalized, walk.marks.length > 0);
  } catch (error) {
    warn("export", error);
  }
}
