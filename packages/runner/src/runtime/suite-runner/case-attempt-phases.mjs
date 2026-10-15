/**
 * The phases of one isolated browser case that are sequences in their own
 * right, split out of case-attempt.mjs so the arc that file describes stays
 * readable: the attempt's workspace, the recording viewport, the result a
 * case owes when it never got a working browser, and the order the attempt's
 * resources are released in.
 *
 * Each is called from exactly one place and the order inside it is the whole
 * point. releaseCaseAttempt in particular is the teardown sequence: evidence
 * recorder before the sidecar whose frames it is still draining, recordings
 * before the stream announcement that retires them, artifacts before the
 * browser they are read from, and the work directory last. It takes every
 * resource the try block opened as one argument for that reason.
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { countChromiumProcesses, readShmBytes } from "../case-artifacts.mjs";
import { infrastructureFailureReason } from "../case-verdicts.mjs";
import { startEvidenceRecorder } from "../evidence-recorder.mjs";
import { joinWalk } from "../recording-capture.mjs";
import { STREAM_GATEWAY_PORT } from "../stream-lane.mjs";
import { checklistFromCheckpoints } from "@shipbash/contracts/runtime/suite-contract.mjs";

import { WORK_DIRECTORY } from "./environment.mjs";
import { redactEventValue, redactString, safeError } from "./redaction.mjs";
import { createWalkRecord } from "./walk-record.mjs";
import { CancellationError, emit, pendingBrowserRecordings } from "./state.mjs";
import {
  announceStreamPort,
  browserEnvironment,
  captureArtifacts,
  caseArtifactDirectory,
  writeFailureDiagnostics,
} from "./browser.mjs";

/** The attempt's two directories, and the browser environment that names them. */
export async function prepareCaseAttemptWorkspace(caseRunId, attempt, executionRound) {
  const artifactDirectory = caseArtifactDirectory(caseRunId, attempt, executionRound);
  const agentWorkDirectory = join(
    WORK_DIRECTORY,
    "case-agent",
    caseRunId,
    `attempt-${attempt}-round-${executionRound}`,
  );
  const resultPath = join(agentWorkDirectory, "agent-result.json");
  await Promise.all([
    mkdir(artifactDirectory, { recursive: true }),
    mkdir(agentWorkDirectory, { recursive: true }),
  ]);
  const env = browserEnvironment(
    caseRunId,
    attempt,
    executionRound,
    artifactDirectory,
  );
  return { artifactDirectory, agentWorkDirectory, resultPath, env };
}

/**
 * The attempt's step record (walk-record.mjs), beside its other evidence: what
 * run and case it belongs to, redacted by the suite's own redactor.
 */
export function startCaseWalkRecord(suite, testCase, context, artifactDirectory) {
  return createWalkRecord({
    directory: artifactDirectory,
    header: {
      runId: suite.familyRunId,
      suiteRunId: suite.suiteRunId,
      caseId: testCase.id,
      caseRunId: context.caseRunId,
      title: testCase.title,
      role: testCase.role ?? "journey",
      attempt: context.attempt,
      round: context.executionRound,
    },
    redactText: (text) => redactString(text, Infinity),
    redactValue: redactEventValue,
  });
}

/** The step recorder, or a note and no recorder; `onUrl` receives every page the sidecar reports. */
export async function startCaseEvidenceRecorder(caseSidecar, artifactDirectory, context, onUrl = null) {
  let evidenceRecorder = null;
  try {
    evidenceRecorder = await startEvidenceRecorder({
      upstreamPort: caseSidecar.port,
      outputDirectory: artifactDirectory,
      onUrl,
    });
  } catch (error) {
    emit("infrastructure", "artifact_capture_failed", {
      ...context,
      kind: "evidence_recorder_start",
      message: safeError(error),
    });
  }
  return evidenceRecorder;
}

/** The stream is up and the gateway is serving it. */
export function emitCaseStreamReady(context) {
  emit("browser", "browser_stream_ready", {
    ...context,
    mode: "case",
    containerPort: STREAM_GATEWAY_PORT,
  });
}

/**
 * A case that never got a working browser failed on ShipBash's side. Setup
 * failures are the ones nobody can diagnose after the fact: the container is
 * gone and its stderr with it, so whatever the failing agent-browser command
 * knew rides out on the event and the durable file.
 */
async function caseInfrastructureError(error, context, artifactDirectory, testCase) {
  const infrastructureEnvelope = {
    message: safeError(error),
    ...(error?.diagnostics ?? {}),
    browserProcesses: countChromiumProcesses(),
    shmBytes: readShmBytes(),
  };
  emit("infrastructure", "case_infrastructure_error", {
    ...context,
    ...infrastructureEnvelope,
  });
  await writeFailureDiagnostics(artifactDirectory, {
    kind: "case_infrastructure_error",
    ...infrastructureEnvelope,
  }, context);
  return {
    outcome: "error",
    authState: "unknown",
    summary: "The isolated browser case could not complete.",
    failureReason: infrastructureFailureReason(error),
    keyActions: [],
    // The artifact must tell the same story as the UI: every checkpoint of
    // the journey exists and none of it ran.
    checklist: checklistFromCheckpoints(testCase.checkpoints).map((item) => ({
      ...item,
      status: "not_run",
      reason: "The case failed before this checkpoint could be attempted.",
    })),
  };
}

/** The video's own stop; an encoder that complains must not mask the case result. */
async function stopCaseStreamRecording(capture, context) {
  try {
    await capture.stop();
  } catch (error) {
    emit("infrastructure", "artifact_capture_failed", {
      ...context,
      kind: "browser_recording_stop",
      message: safeError(error),
    });
  }
}

/**
 * The walk this attempt recorded, if it produced a segment, joined to its case run's recording for the suite to finalize.
 * @param {{ caseRunId: string, attempt: number, capture: ReturnType<typeof import("../recording-capture.mjs").createRecordingCapture>, outcome: string | null }} walk
 */
export async function collectPendingRecordings({ caseRunId, attempt, capture, outcome }) {
  const recorded = await capture.recorded();
  if (recorded.segments.length === 0) return;
  pendingBrowserRecordings.set(caseRunId, joinWalk(pendingBrowserRecordings.get(caseRunId), recorded, { attempt, outcome }));
}

/**
 * The attempt that threw. Cancellation is the caller's to propagate; anything
 * else is ShipBash's own failure and owes the case a result.
 */
export async function failedCaseAttempt(
  error,
  { agentExecution, budget, context, artifactDirectory, testCase },
) {
  if (agentExecution) {
    budget.abort("attempt_failed");
    await agentExecution.catch(() => {});
  }
  if (error instanceof CancellationError) {
    throw error;
  }
  return await caseInfrastructureError(error, context, artifactDirectory, testCase);
}

/**
 * The side that opened each resource closes it, in this order, each step
 * timed on the attempt's close record (`timing`). The browser is the
 * attempt's own to end, after this (executeCaseAttempt).
 */
export async function releaseCaseAttempt(context, resources, timing) {
  const {
    evidenceRecorder, caseSidecar, capture, terminalLane, caseRunId, attempt,
    browserOpened, env, artifactDirectory, traceStarted, trustedAccessNavigation,
    agentWorkDirectory, outcome,
  } = resources;
  // The shell first: `script` ignores SIGHUP, so a session left running holds
  // its stdio pipes open and with them this process. Still before the sidecar,
  // so term_closed reaches viewers on a socket that is still up.
  await timing.time("terminal_close", () => terminalLane?.close().catch(() => {}));
  // Evidence next: pending captures still need the sidecar's frames.
  await timing.time("evidence_close", () => evidenceRecorder?.close().catch(() => {}));
  // Read before the sidecar closes: a browser it found silent or gone is asked for nothing.
  const askBrowser = browserOpened && !caseSidecar?.browserSilent();
  await timing.time("sidecar_close", () => caseSidecar?.close().catch(() => {}));
  await timing.time("recording_stop", () => stopCaseStreamRecording(capture, context));
  await timing.time("pending_recordings", () => collectPendingRecordings({ caseRunId, attempt, capture, outcome }));
  // A failed "no stream" announcement must not mask the case result.
  await timing.time("stream_retire", () => announceStreamPort(null).catch(() => {}));
  if (askBrowser) {
    await timing.time("browser_artifacts", () => captureArtifacts(env, artifactDirectory, traceStarted, context));
  }
  await timing.time("trusted_access_close", () => trustedAccessNavigation?.close().catch(() => {}));
  await timing.time("work_directory", () => rm(agentWorkDirectory, { recursive: true, force: true }));
}
