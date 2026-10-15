/**
 * A finished Suite run's evidence: for each walk, its browser recording and
 * its diagnostic artifacts. Failures degrade honestly: every artifact that
 * could not be kept leaves a warning, the run a count of them, and the
 * verdict stays untouched.
 */
import { basename, relative, sep } from "node:path";

import { PHASE_TIMING_EVENT, type PhaseTiming, startPhaseTiming } from "@shipbash/contracts/runtime/phase-timing.mjs";

import type { SuiteCaseRunReference } from "../dispatch-worker-types.ts";
import type { AppendRunEventForJobInput } from "../store/job-store-inputs.ts";
import { recordingWalkDirectory } from "../suite-recording-source.ts";
import { UNMASKED_TERMINAL_LOG, unmaskedTerminalLog } from "../terminal-session-log.ts";
import { artifactLoss, artifactsIncomplete, replayExportLoss } from "./announcements.ts";
import { isContained } from "../contained-path.ts";
import { mapConcurrent } from "./map-concurrent.ts";
import { artifactKind, prepareArtifactFiles } from "./artifact-files.ts";
import { announceRecording, keepRecording } from "./recording.ts";
import { type EvidenceFile, type EvidencePort, failureText, transferFiles } from "./transfer.ts";

/**
 * The exported replay goes on its own: it is the one file whose row the
 * schema can refuse (kind `video`) and whose bytes the bucket can refuse
 * (`video/mp4`), and that must cost one warning, never the walk's retention.
 */
async function retainReplayExport(port: EvidencePort, caseRunId: string, file: EvidenceFile): Promise<void> {
  await transferFiles(port, [file]).catch(async (error: unknown) => {
    await port.appendRunEventsForJob([
      replayExportLoss(caseRunId, basename(file.path), { artifactId: null, detail: failureText(error) }),
    ]);
  });
}

/** Keeps one walk's artifacts; answers how many it lost. */
async function retainCaseArtifacts(port: EvidencePort, reference: SuiteCaseRunReference, source: string): Promise<number> {
  const { caseRunId } = reference;
  const prepared = await prepareArtifactFiles(source);
  const losses: AppendRunEventForJobInput[] = prepared.failures.map((failure) =>
    artifactLoss(caseRunId, failure, { artifactId: null, detail: failure.message }));
  const files: EvidenceFile[] = [];
  const replays: EvidenceFile[] = [];
  for (const path of prepared.files) {
    if (!isContained(source, path)) throw new Error("Runtime artifact escaped its Case output directory.");
    const file = { path, group: caseRunId, sourcePath: `verification/${reference.directory}/${relative(source, path).split(sep).join("/")}` };
    const kind = artifactKind(path);
    if (kind === "video") replays.push(file);
    // A log its runner never masked is kept by no one.
    else if (await unmaskedTerminalLog(source, path)) {
      losses.push(artifactLoss(caseRunId, { kind, label: basename(path) }, { artifactId: null, detail: UNMASKED_TERMINAL_LOG }));
    } else files.push(file);
  }
  if (losses.length > 0) await port.appendRunEventsForJob(losses);
  const failures = files.length > 0 ? await transferFiles(port, files) : [];
  for (const replay of replays) await retainReplayExport(port, caseRunId, replay);
  return losses.length + failures.filter((failure) => failure !== null).length;
}

/** The retention's own timed stretch, beside the runner's (contracts phase-timing.mjs). */
async function recordTiming(port: EvidencePort, timing: PhaseTiming): Promise<void> {
  const record = timing.record();
  if (!record) return;
  await port.appendRunEventsForJob([{ caseRunId: null, type: PHASE_TIMING_EVENT, level: "info", message: "Phase timing.", data: record }]);
}

/**
 * Walks retained at once. Walks are independent, and most of a walk's time is
 * round trips (prepare, settle, the recording's upload), so walks overlap;
 * within one, its files already go PUT_CONCURRENCY at a time (transfer.ts).
 */
const WALK_CONCURRENCY = 4;

/** Keeps one walk's recording and artifacts; answers how many artifacts it lost. */
async function retainWalk(
  port: EvidencePort,
  reference: SuiteCaseRunReference,
  outputDirectory: string,
  timing: PhaseTiming,
): Promise<number> {
  const source = await recordingWalkDirectory(outputDirectory, reference);
  if (!source) return 0;
  await timing.time("walk_recording", async () => {
    const recording = await keepRecording(port, reference.caseRunId, source, { retryFailed: false, expected: false });
    await announceRecording(port, reference.caseRunId, recording);
  });
  return timing.time("walk_artifacts", () => retainCaseArtifacts(port, reference, source));
}

export async function retainSuiteEvidence(
  port: EvidencePort,
  input: { outputDirectory: string; caseRuns: ReadonlyArray<SuiteCaseRunReference> },
): Promise<void> {
  const timing = startPhaseTiming("host_finalize");
  const losses = await mapConcurrent(
    input.caseRuns,
    WALK_CONCURRENCY,
    (reference) => retainWalk(port, reference, input.outputDirectory, timing),
  );
  const unavailable = losses.reduce((sum, lost) => sum + lost, 0);
  if (unavailable > 0) await port.appendRunEventsForJob([artifactsIncomplete(unavailable)]);
  await recordTiming(port, timing);
}
