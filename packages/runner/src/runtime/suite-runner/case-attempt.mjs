// One isolated browser case attempt, from trusted-access setup through the
// agent turn to artifact capture. The arc is this file; the phases that are
// sequences in their own right — the workspace, the recording viewport, the
// failure result and the teardown order — live next door in
// case-attempt-phases.mjs, each called from exactly one place here.
import { startPhaseTiming } from "@shipbash/contracts/runtime/phase-timing.mjs";

import { recordingSegmentPath } from "../browser-recording.mjs";
import { cloudflareChallengeBlockedResult } from "../case-verdicts.mjs";
import { NOT_RETAINED } from "../evidence-recorder.mjs";
import { createRecordingCapture } from "../recording-capture.mjs";
import { recordingNow } from "../recording-now.mjs";
import { registerRuntimeSecrets } from "../runtime-secrets.mjs";
import { createAgentBudget } from "../pi-agent.mjs";
import { endScreencastBlackout } from "../screencast-blackout.mjs";
import { startScreencastSidecar } from "../screencast-sidecar.mjs";
import { createTerminalLane } from "../terminal-lane.mjs";
import { consumeTrustedAccessConfig } from "../trusted-access.mjs";

import { HOME_DIRECTORY, SIGN_IN_HEADLESS, chromeTraceEnabled } from "./environment.mjs";
import { redactEventValue, redactor, registerCredentialValues, registerSecret, registerTrustedAccess, safeError } from "./redaction.mjs";
import { addWalkTime, emit, emitPhaseTiming, pollCancelRequested } from "./state.mjs";
import {
  agentBrowser,
  announceStreamPort,
  inspectCloudflareChallenge,
  openProductionBrowser,
} from "./browser.mjs";
import { launchHarnessBrowser } from "../harness-browser.mjs";
import { BROWSER_SOURCE } from "./agent-lifecycle.mjs";
import { credentialsAvailable, startCredentialControl } from "../credentials-control.mjs";
import { caseAgentTimeoutMs, runCase } from "./case-agent.mjs";
import { caseSourceWatch } from "./case-source-watch.mjs";
import { prepareCaseEntryCheck, reportEntryCheckRefusal } from "./case-entry-check.mjs";
import {
  emitCaseStreamReady,
  failedCaseAttempt,
  prepareCaseAttemptWorkspace,
  releaseCaseAttempt,
  startCaseEvidenceRecorder,
  startCaseWalkRecord,
} from "./case-attempt-phases.mjs";

/** The browser video for this attempt (recording-capture.mjs), or a note and no recorder. */
async function startCaseStreamRecording({ capture, upstreamPort, context }) {
  try {
    await capture.start({ upstreamPort });
  } catch (error) {
    emit("infrastructure", "artifact_capture_failed", {
      ...context,
      kind: "browser_recording_start",
      message: safeError(error),
    });
  }
}

/**
 * This attempt's sandbox shell, recording into the case's own artifact
 * directory so its ndjson rides the artifact walk the host already does. What
 * the shell can print is registered for masking before it opens — the keys
 * and the sign-in this walk runs with (`statePath`). A log the lane stops
 * because its output could not be masked is a capture the attempt could not
 * make, and says so in the words it uses for one.
 *
 * The channel directory comes first: the suite lane creates only the control
 * root and its auth directory, so without this the agent's terminal_run
 * writes its request into a directory that does not exist, and the lane it is
 * talking to never hears a word. The Activity lane prepares the same layout
 * from the same helper, and preparing it per attempt also clears the request
 * and response a previous Journey left behind.
 *
 * A URL a program in the shell opens (a CLI's sign-in page) opens in a new tab
 * of this attempt's browser, as agent_browser_tab_new opens one.
 */
async function createCaseTerminalLane({ artifactDirectory, context, statePath, env }) {
  await registerRuntimeSecrets(registerSecret, { statePath });
  return createTerminalLane({
    outputRoot: artifactDirectory,
    homeDirectory: HOME_DIRECTORY,
    redactor,
    onSessionOpened: (message) => emit("case", "terminal_session_opened", { ...context, message }),
    onLogStopped: (message) => emit("infrastructure", "artifact_capture_failed", { ...context, kind: "terminal_log", message }),
    openUrl: (url) => agentBrowser(["tab", "new", url], env),
    // Its logs' clock is the recording's, so a shell's output lands on the frame it was printed on.
    now: recordingNow,
  });
}

/** The credential bridge for this attempt; a served value too short to mask is said once. */
function startCaseCredentialControl(context) {
  return startCredentialControl({
    registerSecrets: registerCredentialValues,
    onUnmasked: (name) => emit("case", "credential_unmasked", {
      ...context, message: `The saved sign-in's ${name} is too short to mask in this run's logs.`,
    }),
  });
}

/**
 * The seam every completed MCP call arrives at: the recording's attention
 * track wants all of them, while the browser's evidence recorder is its own
 * server's alone. The recorder is read through a thunk: it is created after
 * this is, and replaced as the attempt goes.
 */
function caseToolCompleted(capture, recorder) {
  return (completion) => {
    capture.action(completion);
    // No recorder keeps no picture: the same answer as a step whose picture was lost.
    if (completion.server === BROWSER_SOURCE) return recorder()?.captureStep(completion) ?? Promise.resolve(NOT_RETAINED);
  };
}

/** The Cloudflare wall, reported as a block against this case's checkpoints. */
function blockedByCloudflare(challenge, context, initialChecklist, testCase) {
  const blocked = cloudflareChallengeBlockedResult(initialChecklist ?? [], testCase.checkpoints);
  emit("case", "case_blocked", {
    ...context,
    attentionCode: "cloudflare_challenge",
    pageTitle: challenge.title,
    pageUrl: challenge.url,
    message: blocked.failureReason,
  });
  return blocked;
}

/** Chrome traces are heavy and stay off unless asked for; trusted access opts out. */
async function startChromeTrace(env, trustedAccess, context) {
  if (!chromeTraceEnabled() || trustedAccess || credentialsAvailable()) return false;
  try {
    await agentBrowser(["trace", "start"], env);
    return true;
  } catch (error) {
    emit("infrastructure", "artifact_capture_failed", {
      ...context,
      kind: "chrome_trace_start",
      message: safeError(error),
    });
    return false;
  }
}

/**
 * The blackout outlives the credential control on purpose: the key
 * screenshot is taken during the release and skipped while a code may still
 * be on screen. It ends with the attempt, so it never hides the next case.
 */
async function releaseAttemptWithCredentials(context, resources, control, timing) {
  await control?.close().catch(() => {});
  try {
    await releaseCaseAttempt(context, resources, timing);
  } finally {
    endScreencastBlackout();
  }
}

/**
 * The attempt's end: the walk's record, the release in its order, and last
 * the browser. The side that launched the browser ends it,
 * cancellation or not, and whatever in the teardown before it failed: a
 * browser left running would outlive the attempt in this container.
 */
async function finishCaseAttempt(context, { budget, walk, attemptResult, laneBrowser, resources, control, timing }) {
  try {
    budget.dispose();
    await timing.time("walk_record", () => walk.finish(attemptResult));
    await releaseAttemptWithCredentials(context, resources, control, timing);
  } finally {
    await timing.time("browser_close", () => laneBrowser?.close());
    emitPhaseTiming(timing, context);
  }
}

/**
 * One execution round of a case, its time added to the case's walking time
 * (state.mjs takeWalkMs), whatever way the round ends. A reproduction carries
 * the first walk's result (`firstWalk`), which its supervising agent reads.
 */
export async function executeCaseAttempt(
  suite, testCase, caseRunId, attempt, executionRound, statePath,
  initialChecklist = null, signInWriteback = null, firstWalk = null,
) {
  const started = performance.now();
  try {
    return await walkCaseAttempt(
      suite, testCase, caseRunId, attempt, executionRound, statePath, initialChecklist, signInWriteback, firstWalk,
    );
  } finally {
    addWalkTime(caseRunId, performance.now() - started);
  }
}

async function walkCaseAttempt(
  suite, testCase, caseRunId, attempt, executionRound, statePath,
  initialChecklist, signInWriteback, firstWalk,
) {
  // Each step from the workspace to the live stream, then each from the verdict to the browser closed.
  const setup = startPhaseTiming("case_setup");
  const close = startPhaseTiming("case_close");
  const { artifactDirectory, agentWorkDirectory, resultPath, env } = await setup.time(
    "workspace",
    () => prepareCaseAttemptWorkspace(caseRunId, attempt, executionRound),
  );
  const context = { caseRunId, caseId: testCase.id, attempt, executionRound };
  // The attempt's browser once the harness launched it, which the teardown
  // ends; open once the product is.
  let laneBrowser = null;
  let browserOpened = false;
  let trustedAccessNavigation = null;
  let traceStarted = false;
  let caseSidecar = null;
  let terminalLane = null;
  let evidenceRecorder = null;
  let credentialControl = null;
  // The attempt's browser video and the tracks that ride it, all on one clock.
  const capture = createRecordingCapture({
    outputPath: recordingSegmentPath(artifactDirectory, executionRound),
    redact: redactEventValue,
    terminalLane: () => terminalLane,
  });
  const onToolCompleted = caseToolCompleted(capture, () => evidenceRecorder);
  // How this walk ended, read by the teardown below: the finally block runs
  // after the result is in hand but cannot see the returned value, and the
  // walk's segments and step record are filed with the result they ended on.
  // Null is a walk that never reached a result — cancellation rethrows past
  // every return.
  let attemptResult = null;
  const endedWith = (caseResult) => {
    attemptResult = caseResult;
    return caseResult;
  };
  const walk = startCaseWalkRecord(suite, testCase, context, artifactDirectory);

  emit("case", "case_attempt_started", context);
  // Every way this walk can be cut short, as one signal: its wall-clock
  // budget, the run's cancel sentinel, and the drift the case agent aborts on.
  const budget = createAgentBudget({
    timeoutMs: caseAgentTimeoutMs(testCase),
    isCancelRequested: pollCancelRequested,
  });
  let agentExecution = null;
  try {
    const trustedAccess = await setup.time("trusted_access", () => consumeTrustedAccessConfig(suite.productionUrl));
    registerTrustedAccess(trustedAccess);
    laneBrowser = await setup.time("launch_browser", () => launchHarnessBrowser({ env, desktop: !SIGN_IN_HEADLESS }));
    trustedAccessNavigation = await openProductionBrowser(suite.productionUrl, statePath, env, trustedAccess, { timing: setup });
    browserOpened = true;
    const challenge = await setup.time("cloudflare_check", () => inspectCloudflareChallenge(env));
    if (challenge) {
      return endedWith(blockedByCloudflare(challenge, context, initialChecklist, testCase));
    }
    const entryCheck = await setup.time(
      "entry_check",
      () => prepareCaseEntryCheck({ productionUrl: suite.productionUrl, statePath, agentWorkDirectory }),
    );
    credentialControl = await setup.time("sign_in_control", () => startCaseCredentialControl(context));
    // The lane answers terminal_run from the moment the agent can call it,
    // which is its first turn — so it opens before the agent, not with the sidecar.
    terminalLane = await setup.time("terminal_lane", () => createCaseTerminalLane({ artifactDirectory, context, statePath, env }));
    terminalLane.start();
    // Pixels ride their own CDP connection to the attempt's browser: the
    // sidecar follows the active tab through Target events, so no follower,
    // no stream restarts, and no frame traffic competing with the agent's
    // command channel.
    caseSidecar = await setup.time("screencast_sidecar", () => startScreencastSidecar({
      cdpUrl: laneBrowser.cdpUrl,
      // term_* rides the same socket and the same control lease as the pixels.
      terminalLane,
      ...caseSourceWatch(budget, context),
    }));
    await setup.time("announce_stream", () => announceStreamPort(caseSidecar.port));
    evidenceRecorder = await setup.time(
      "evidence_recorder",
      () => startCaseEvidenceRecorder(caseSidecar, artifactDirectory, context, entryCheck?.pages.record ?? null),
    );
    await setup.time("stream_recording", () => startCaseStreamRecording({ capture, upstreamPort: caseSidecar.port, context }));
    traceStarted = await setup.time("chrome_trace", () => startChromeTrace(env, trustedAccess, context));
    emitPhaseTiming(setup, context);
    emitCaseStreamReady(context);
    // Jev can act immediately: retain evidence before starting any execution.
    agentExecution = runCase(
      suite, testCase, caseRunId, attempt, executionRound, env, resultPath,
      initialChecklist,
      (cue) => capture.caption(cue),
      (pointer) => capture.point(pointer),
      budget, onToolCompleted, walk, terminalLane, credentialControl, firstWalk,
    );
    const caseResult = endedWith(reportEntryCheckRefusal(entryCheck, context, await agentExecution));
    await close.time("report_outcome", () => credentialControl?.reportOutcome(testCase.id, caseResult, safeError));
    await close.time("sign_in_close", () => credentialControl?.close());
    // The run's last authenticated case writes its sign-in state back while its
    // browser is still open (the finally below closes it), so rotated cookies
    // reach the host instead of dying with the case, and a session this case
    // signed in for with saved credentials reaches the cases after it.
    if (signInWriteback) {
      await close.time("sign_in_writeback", () => signInWriteback(caseResult, env, credentialControl?.fetchedCredentials() ?? false));
    }
    return caseResult;
  } catch (error) {
    return endedWith(await failedCaseAttempt(error, {
      agentExecution, budget, context, artifactDirectory, testCase,
    }));
  } finally {
    await finishCaseAttempt(context, {
      budget, walk, attemptResult, laneBrowser, control: credentialControl, timing: close,
      resources: {
        terminalLane, evidenceRecorder, caseSidecar, capture, caseRunId, attempt, browserOpened, env, artifactDirectory,
        traceStarted, trustedAccessNavigation, agentWorkDirectory, outcome: attemptResult?.outcome ?? null,
      },
    });
  }
}
