/**
 * Two phases of the Activity lane that are sequences in their own right,
 * split out of run-activity.mjs so the arc that file describes stays
 * readable: what a failed agent turn leaves on disk, and the order the
 * session's resources are released in.
 *
 * Both are still called from exactly one place, and the order inside each is
 * the whole point — teardown must see every resource the try block opened,
 * and it runs lane before sidecar, evidence before the sidecar's buffer is
 * discarded, and the browser before the display it was drawn on.
 */
import { readFile, rm, writeFile } from "node:fs/promises";

import { AGENT_RESULT_PATH, HUMAN_AUTH_PASSWORD_PATH } from "./environment.mjs";
import { emit, getBrowserLifecycleFault } from "./state.mjs";
import { stopManagedServices } from "./processes.mjs";
import { announceStreamPort } from "./browser.mjs";
import { retainActivityEvidence } from "./stream-stack.mjs";
import { exportWalkRecording, stopWalkRecording } from "./walk-recording.mjs";
import {
  browserLifecycleFaultResult,
  nonEmptyFile,
  sanitizeVisitedUrls,
  validateActivityResult,
} from "./results.mjs";

/** Preserve only fields that passed the same contract as a normal outcome. */
async function validatedAgentResult(activity) {
  try {
    const raw = JSON.parse(await readFile(AGENT_RESULT_PATH, "utf8"));
    return validateActivityResult(sanitizeVisitedUrls(raw, activity.productionUrl), activity);
  } catch {
    return null;
  }
}

/** Build a fault result from validated work; raw agent JSON never crosses this seam. */
async function browserFaultResult(fault, activity) {
  const prior = await validatedAgentResult(activity);
  return {
    ...browserLifecycleFaultResult(fault, activity.productionUrl),
    visitedUrls: prior?.visitedUrls ?? [activity.productionUrl],
    proposals: prior?.proposals ?? [],
  };
}

/**
 * An agent turn that did not end cleanly still owes the Activity a result.
 * The browser dying under it is recoverable: that result is written to the
 * result file and the walk continues from it. Anything else throws, naming
 * every reason it could not finish — a model call the gateway refused among
 * them.
 */
export async function settleAgentResultFile({ turn, lifecycleFailure, agentFailure, activity }) {
  const fault = getBrowserLifecycleFault();
  if (fault) {
    await writeFile(AGENT_RESULT_PATH, `${JSON.stringify(await browserFaultResult(fault, activity))}\n`, { mode: 0o600 });
    return;
  }
  if (turn.code !== 0 || lifecycleFailure || !(await nonEmptyFile(AGENT_RESULT_PATH))) {
    const details = [
      `exit code ${String(turn.code)}`,
      ...(turn.signal ? [`signal ${turn.signal}`] : []),
      ...(lifecycleFailure ? ["a failed agent turn"] : []),
      ...((await nonEmptyFile(AGENT_RESULT_PATH)) ? [] : ["no structured result file"]),
      ...(agentFailure ? [`agent error: ${agentFailure}`] : []),
    ];
    throw new Error(`Activity Agent did not complete successfully (${details.join(", ")}).`);
  }
}

/** The session's teardown, in the one order it may run in. */
export async function releaseActivityResources(session) {
  const {
    terminalLane,
    browser,
    browserOpened,
    activitySidecar,
    pageMetadata,
    trustedAccessNavigation,
    displayServices,
    runtimeInstance,
    activityStartedAt,
    authHandoffCount,
  } = session;
  try {
    // Lane before sidecar: term_closed still reaches viewers on the socket.
    await terminalLane.close().catch(() => {});
    // Evidence before the sidecar closes: the frozen final frame is read from
    // the sidecar's live buffer, which the close would discard, and it says
    // whether the browser is silent or gone, which is then asked nothing more.
    if (browserOpened) {
      await retainActivityEvidence({ sidecar: activitySidecar, pageMetadata });
    }
    // The recorder drains the sidecar's frames, so it stops before the sidecar closes.
    await stopWalkRecording();
    await activitySidecar?.close().catch(() => {});
    // A failed "no stream" announcement must not mask the Activity result.
    await announceStreamPort(null).catch(() => {});
    await trustedAccessNavigation?.close().catch(() => {});
  } finally {
    // The side that launched the browser ends it, cancellation or not, and
    // whatever above failed: by its process group, never waiting on a
    // browser that may be frozen.
    await browser?.close();
    await stopManagedServices(displayServices);
    await rm(HUMAN_AUTH_PASSWORD_PATH, { force: true });
    // Last, with the browser and its display gone: the export has the machine to
    // itself. A leg that parks on a sign-in is not the walk's end, and keeps
    // none: the leg that resumes it records afresh.
    if (authHandoffCount === 0) await exportWalkRecording();
  }
  emit("lifecycle", "Activity resources released", {
    safeData: {
      event: "activity_runtime_stopped",
      runtimeInstance,
      durationMs: Date.now() - activityStartedAt,
      authHandoffs: authHandoffCount,
    },
  });
}
