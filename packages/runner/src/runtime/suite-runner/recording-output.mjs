// What a finished case leaves behind: the assembled browser recording and
// the per-case result file. Both write into the case's output directory and
// both must survive partial failure without masking the case verdict.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { startPhaseTiming } from "@shipbash/contracts/runtime/phase-timing.mjs";

import { fileBrowserRecording, finalizeBrowserRecording } from "../recording-finalize.mjs";
import { FALLBACK_NARRATION } from "../recording-playback.mjs";
import { exportFinalizedReplay } from "../replay-export.mjs";

import { OUTPUT_ROOT } from "./environment.mjs";
import { redactEventValue, redactor, safeError } from "./redaction.mjs";
import { emit, emitPhaseTiming, pendingBrowserRecordings } from "./state.mjs";

/**
 * The replay exports, one after another in the order the cases finished. An
 * export is a second full pass over the video and draws its shells in a
 * browser of its own, so it is started here and awaited only at the very end
 * of the run — teardown walks while it encodes, and the case's verdict has
 * already been decided either way — but never beside another export: at most
 * one competes with the next case's live walk. The container may not exit
 * before the chain settles: the host collects the case's artifacts only once
 * it has.
 */
let replayExports = Promise.resolve();

/** The exported replay is evidence, never a verdict: a failure is an event. */
function startCaseReplayExport(caseRunId, attempt, recording) {
  const failed = (kind) => (error) => {
    emit("infrastructure", "artifact_capture_failed", { caseRunId, attempt, kind, message: safeError(error) });
  };
  // How long it waited behind the exports before it, and how long its own took.
  const timing = startPhaseTiming("replay_export");
  const earlier = replayExports;
  replayExports = timing.time("queue_wait", () => earlier)
    .then(() => timing.time("export", () => exportFinalizedReplay(recording, {
      caseDirectory: join(OUTPUT_ROOT, caseRunId),
      // The replay still goes out, with the browser where the shell would be.
      reportTerminalFailure: failed("case_replay_terminal"),
    })))
    .catch(failed("case_replay_export"))
    .finally(() => emitPhaseTiming(timing, { caseRunId, attempt }));
}

export async function finalizeCaseBrowserRecording(caseRunId, attempt, result = null) {
  const pending = pendingBrowserRecordings.get(caseRunId);
  if (!pending) return null;
  pendingBrowserRecordings.delete(caseRunId);
  const outputDirectory = join(OUTPUT_ROOT, caseRunId);
  const timing = startPhaseTiming("recording_close");
  try {
    // Each segment names the walk that wrote it and how that walk ended: a case
    // run walked twice gets a chapter per walk instead of one unbroken take.
    const finalized = await timing.time("recording_finalize", () => finalizeBrowserRecording(pending, {
      outputDirectory,
      fallback: result?.outcome === "passed" ? FALLBACK_NARRATION.passedJourney : FALLBACK_NARRATION.journey,
      // Its words masked with every secret this run registered, as its shells' logs are.
      redactor,
    }));
    // The poster and document the console reads beside the video.
    const recording = finalized && await timing.time("recording_file", () => fileBrowserRecording(finalized, outputDirectory));
    if (recording) {
      startCaseReplayExport(caseRunId, attempt, recording);
      emit("browser", "browser_recording_ready", {
        caseRunId,
        attempt,
        width: recording.width,
        height: recording.height,
        durationMs: recording.durationMs,
        poster: recording.posterPath !== null,
      });
    }
    return recording;
  } catch (error) {
    emit("infrastructure", "artifact_capture_failed", {
      caseRunId,
      attempt,
      kind: "browser_recording_finalize",
      message: safeError(error),
    });
    return null;
  } finally {
    emitPhaseTiming(timing, { caseRunId, attempt });
  }
}

export async function finalizePendingBrowserRecordings() {
  for (const [caseRunId, pending] of [...pendingBrowserRecordings]) {
    await finalizeCaseBrowserRecording(caseRunId, pending.attempt);
  }
  await replayExports;
}

export async function writeCaseResult(caseRunId, result) {
  const resultPath = join(OUTPUT_ROOT, caseRunId, "result.json");
  await mkdir(join(OUTPUT_ROOT, caseRunId), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(redactEventValue(result), null, 2)}\n`, {
    mode: 0o600,
  });
  return resultPath;
}
