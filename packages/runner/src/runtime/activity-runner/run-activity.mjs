// The Activity lane, kept whole where order is the point: runActivity is one
// browser session's full arc — sentinel reset, display, browser open, stream
// stack, one agent turn, result validation, retention — and its finally block
// is a single teardown sequence (terminal lane → sidecar → evidence retention
// → stream announcement → trusted access → browser close → display services →
// password file → a walk's recording export) that must see every resource the
// try block opened; the leg object is that list, filled in as each resource
// opens. What each phase does
// lives in the functions below and the sibling modules (stream-stack,
// results); the order they happen in lives in runActivity and nowhere else.
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { prepareDiscoveryChannels } from "@shipbash/contracts/runtime/discovery-surface.mjs";
import { recordingNow } from "../recording-now.mjs";
import { createTerminalLane } from "../terminal-lane.mjs";
import { registerRuntimeSecrets } from "../runtime-secrets.mjs";
import { emitPrematureStopWarning } from "../conclusion-gate.mjs";
import { consumeTrustedAccessConfig } from "../trusted-access.mjs";
import { consumeTaskApiConfig } from "../task-api.mjs";
import { launchHarnessBrowser } from "../harness-browser.mjs";
import { existingStateFile } from "../browser-state-seal.mjs";

import {
  AGENT_RESULT_PATH,
  AUTH_CANDIDATE_PATH,
  AUTH_CANDIDATE_READY_PATH,
  AUTH_STATE_PATH,
  CONTROL_ROOT,
  HOME_DIRECTORY,
  HUMAN_AUTH_CANCEL_PATH,
  HUMAN_AUTH_COMPLETE_PATH,
  HUMAN_AUTH_DISPLAY,
  HUMAN_AUTH_REQUEST_PATH,
  HUMAN_AUTH_RESUMED_PATH,
  HUMAN_AUTH_ROOT,
  INPUT_PATH,
  OUTPUT_ROOT,
  PROGRESS_PATH,
  activityDeadlineRemainingMs,
  validateActivity,
} from "./environment.mjs";
import { redactor, registerSecret, registerTrustedAccess } from "./redaction.mjs";
import {
  CancellationError,
  emit,
  isAuthCandidatePending,
  setActivityId,
} from "./state.mjs";
import {
  maximizeActivityBrowserWindow,
  startActivityDisplay,
  waitForActivityBrowserWindow,
} from "./display.mjs";
import {
  captureNarrativeThumbnail,
  cleanEnvironment,
  inspectCloudflareChallenge,
  openProductionBrowser,
  startActivityPointerReader,
} from "./browser.mjs";
import { openingFrameContext } from "./opening-frame.mjs";
import { openingEntry } from "./sign-in-entry.mjs";
import {
  createAgentActionEmitter,
  createPageMetadataPublisher,
  openTerminalUrl,
  startActivityStreamStack,
} from "./stream-stack.mjs";
import { executeAgentTurn } from "./agent-session.mjs";
import { releaseActivityResources, settleAgentResultFile } from "./run-activity-phases.mjs";
import { endScreencastBlackout } from "../screencast-blackout.mjs";
import { startActivityProgressReader } from "./progress-reader.mjs";
import { markWalkRecording, pointWalkRecording, startWalkNarration, startWalkRecording } from "./walk-recording.mjs";
import {
  publishActivityOutcome,
  publishCloudflareBlocked,
  retainSignInState,
  sanitizeVisitedUrls,
  validateActivityResult,
} from "./results.mjs";

/** Which sign-in state this leg restored: a handoff's capture, or the saved one. */
function signInStateSourceFor(authStatePath, candidateReady) {
  if (authStatePath === null) return null;
  return candidateReady ? "handoff_candidate" : "saved_state";
}

function emitWaitingForAuthentication(runtimeInstance, reason, handoff) {
  emit("lifecycle", "Waiting for authentication", {
    bodyMarkdown: reason,
    safeData: {
      mode: "activity",
      event: "human_auth_requested",
      status: "waiting_for_auth",
      runtimeInstance,
      handoff,
    },
  });
}

/**
 * The workspace a leg starts from: its input read, the sentinels a previous
 * leg left cleared, the control channels, Trusted Access registered for
 * redaction, the credential broker taken off the control mount, and the child
 * environment the browser proxy and the browser inherit. The broker comes before the
 * saved sign-in's cookies are registered: a cookie naming one of its accounts
 * is left unmasked (runtime-secrets.mjs).
 */
async function prepareActivityLeg() {
  const activity = validateActivity(JSON.parse(await readFile(INPUT_PATH, "utf8")));
  setActivityId(activity.activityId);
  await Promise.all([mkdir(OUTPUT_ROOT, { recursive: true }), mkdir(HUMAN_AUTH_ROOT, { recursive: true })]);
  await Promise.all([
    rm(HUMAN_AUTH_REQUEST_PATH, { force: true }),
    rm(HUMAN_AUTH_COMPLETE_PATH, { force: true }),
    rm(HUMAN_AUTH_CANCEL_PATH, { force: true }),
    rm(HUMAN_AUTH_RESUMED_PATH, { force: true }),
  ]);
  await prepareDiscoveryChannels(CONTROL_ROOT, { mkdir, rm, join });
  const trustedAccess = await consumeTrustedAccessConfig(activity.productionUrl);
  registerTrustedAccess(trustedAccess);
  await consumeTaskApiConfig({ root: CONTROL_ROOT, registerSecret });
  const env = cleanEnvironment(activity);
  // Every interaction channel hangs off the control root: the browser proxy
  // derives its wrap-up and page-note paths from it, and the leg's tools
  // theirs. The capability table decides what may be called (contracts capabilities.mjs).
  env.SHIPBASH_CONTROL_ROOT = CONTROL_ROOT;
  return { activity, trustedAccess, env };
}

/**
 * The display, then the product in the browser — on the page the saved
 * sign-in was captured on. What it starts is recorded on the leg the
 * moment it exists, so the teardown releases it whatever happens next.
 */
async function openActivityBrowser(activity, leg, trustedAccess) {
  leg.displayServices = await startActivityDisplay(leg.env);
  emit("evidence", "Browser workspace ready", {
    safeData: {
      event: "activity_display_ready",
      runtimeInstance: leg.runtimeInstance,
      serviceCount: leg.displayServices.length,
    },
  });
  const candidateReady = existsSync(AUTH_CANDIDATE_READY_PATH);
  const authStatePath = existingStateFile(candidateReady ? AUTH_CANDIDATE_PATH : AUTH_STATE_PATH);
  const signInStateSource = signInStateSourceFor(authStatePath, candidateReady);
  // A saved sign-in opens on the page it was captured on, not the root.
  const entry = openingEntry({ productionUrl: activity.productionUrl, signInStateSource });
  leg.browser = await launchHarnessBrowser({ env: leg.env, desktop: true });
  leg.trustedAccessNavigation = await openProductionBrowser(entry.url, authStatePath, leg.env, trustedAccess);
  leg.browserOpened = true;
  emit("evidence", "Browser session opened", {
    safeData: {
      event: "activity_browser_opened",
      runtimeInstance: leg.runtimeInstance,
      reusedAuthentication: authStatePath !== null,
      signInStateSource,
      openedAt: entry.source,
    },
  });
  return { authStatePath, signInStateSource, entry };
}

/**
 * The window is sized before any pixel leaves the browser. Headed Chromium
 * screencasts its real window, not the emulated viewport, so a stream that
 * opened against Chromium's small default window streamed — and recorded —
 * that size (measured: a 640x662 video of a 1920x1080 run).
 */
async function sizeActivityBrowserWindow(env, runtimeInstance) {
  await waitForActivityBrowserWindow(env);
  const initialBrowserWindow = await maximizeActivityBrowserWindow(env);
  process.stderr.write(
    `[shipbash-activity-runner] browser_window_ready phase=initial runtime=${runtimeInstance} display=${HUMAN_AUTH_DISPLAY} width=${String(initialBrowserWindow.width)} height=${String(initialBrowserWindow.height)}\n`,
  );
  emit("evidence", "Interactive browser ready", {
    safeData: {
      event: "activity_browser_window_ready",
      runtimeInstance,
      width: initialBrowserWindow.width,
      height: initialBrowserWindow.height,
    },
  });
}

/**
 * One agent turn, with the progress, pointer and narration readers running
 * only while it does. What the turn and the readers report back — the words
 * the owner was shown, a warning the turn raised, the agent's own failure —
 * stays local and is read once the turn has ended; only the handoffs filed
 * are counted on the leg, because the teardown reports them however the turn
 * ended.
 */
async function runAgentTurn({ activity, leg, opening, assistantFeed }) {
  const { runtimeInstance } = leg;
  let lifecycleFailure = false;
  const publicMessages = new Set();
  let agentFailure = null;
  const progressReader = await startActivityProgressReader(PROGRESS_PATH, async (update) => {
    if (update.event === "agent_output") publicMessages.add(update.markdown.trim());
    if (update.event === "journey_mark") markWalkRecording(update);
    if (update.event !== "human_auth_request") return;
    leg.authHandoffCount += 1;
    // Nothing waits here, and that is the fix. A person may sign in within
    // the minute or tomorrow morning, and no agent turn outlives that span:
    // the turn this used to block would be cancelled out from under the
    // request long before the sign-in landed, which is how a completed
    // sign-in still came back asking to sign in. So the Agent files the
    // request, ends its turn, and this runtime is released. The Activity
    // parks on waiting_for_auth, sign-in gets a container of its own, and
    // the round that resumes carries the session it captured.
    emitWaitingForAuthentication(runtimeInstance, update.reason, leg.authHandoffCount);
  }, {
    captureScreenshot: () => captureNarrativeThumbnail(leg.env),
  });
  const pointerReader = startActivityPointerReader(pointWalkRecording);
  const narrationReader = await startWalkNarration();
  let turn;
  const agentStartedAt = Date.now();
  // Said once pi has opened the session, from what it loaded: a leg resumes
  // only the conversation its session directory held when it started.
  const onSessionOpened = ({ resumed, messages }) => emit("lifecycle", "Agent session started", {
    safeData: {
      event: "agent_session_started",
      runtimeInstance,
      resumed, resumedMessages: messages, deadlineRemainingMs: activityDeadlineRemainingMs(),
    },
  });
  const publishProjected = (projected) => {
    if (!projected) return;
    if (projected.kind === "warning") lifecycleFailure = true;
    if (projected.safeData?.event === "agent_output" && projected.bodyMarkdown) {
      publicMessages.add(projected.bodyMarkdown.trim());
    }
    emit(projected.kind, projected.label, {
      bodyMarkdown: projected.bodyMarkdown,
      safeData: projected.safeData,
    });
  };
  try {
    turn = await executeAgentTurn({
      activity,
      env: leg.env,
      publishProjected,
      assistantFeed,
      ...opening,
      onSessionOpened,
      // Jev reads the leg's terminal beside the page, as a Journey run's does.
      terminal: leg.terminalLane,
      ...createAgentActionEmitter(leg.pageMetadata, { sidecar: leg.activitySidecar, environment: () => leg.env }),
      onAgentFailure: (message) => {
        agentFailure = message;
      },
    });
  } finally {
    await progressReader.stop();
    await pointerReader.stop();
    await narrationReader.stop();
  }
  emit("lifecycle", "Agent session finished", {
    safeData: {
      event: "agent_session_finished",
      runtimeInstance,
      durationMs: Date.now() - agentStartedAt,
      exitCode: turn.code,
      canceled: turn.canceled,
      timedOut: turn.timedOut, waitedMs: turn.waitedMs,
      authHandoffs: leg.authHandoffCount,
    },
  });
  if (turn.canceled) throw new CancellationError();
  if (turn.timedOut && turn.code !== 0) { // exit 0: the slot closed the leg on the Journeys it kept
    emit("warning", "Activity timed out", { safeData: { category: "timeout", waitedMs: turn.waitedMs } });
    throw new Error("Activity Agent exceeded its execution timeout.");
  }
  await settleAgentResultFile({ turn, lifecycleFailure, agentFailure, activity });
  return { turn, publicMessages };
}

/** The turn's result as the owner receives it, with the sign-in the leg used written back. */
async function deliverActivityResult({ activity, leg, turn, publicMessages, authStatePath }) {
  const { env } = leg;
  let result = validateActivityResult(
    sanitizeVisitedUrls(JSON.parse(await readFile(AGENT_RESULT_PATH, "utf8")), activity.productionUrl),
    activity,
  );
  // auth_required is a pause, not a dead end. Releasing this runtime is the
  // point: the Activity parks on waiting_for_auth and keeps what it found,
  // Take control opens a container of its own whenever the owner gets to
  // it, and finishing the sign-in starts the round that walks past this
  // wall. Asking is the recovery, so the walk never says "retry".
  if (result.status === "auth_required") {
    result = { ...result, recoveryAction: "Take control to sign in." };
  }
  if (!turn.timedOut) await emitPrematureStopWarning(result, emit); // the gate reconciles the agent's own claim, not a harness stop
  // Every leg that used or produced a sign-in writes it back (results.mjs
  // retainSignInState decides), not only the ones where the agent filed a
  // request: a steady-state leg's rotated cookies would otherwise be
  // stranded here and the saved state would age until it silently expired.
  await retainSignInState(env, activity.productionUrl, {
    result, authStatePath, handoff: isAuthCandidatePending(),
  });
  await publishActivityOutcome({
    result,
    runtimeInstance: leg.runtimeInstance,
    activityStartedAt: leg.activityStartedAt,
    authHandoffCount: leg.authHandoffCount,
    publicMessages,
    activityKind: activity.kind,
  });
}

export async function runActivity() {
  const { activity, trustedAccess, env } = await prepareActivityLeg();
  const runtimeInstance = env.AGENT_BROWSER_SESSION;
  // Everything the teardown must see (releaseActivityResources), filled in
  // as the leg opens it.
  const leg = {
    env,
    runtimeInstance,
    activityStartedAt: Date.now(),
    // The harness's browser once launched, which the teardown ends; open once the product is.
    browser: null,
    browserOpened: false,
    displayServices: [],
    authHandoffCount: 0,
    trustedAccessNavigation: null,
    activitySidecar: null,
    terminalLane: createTerminalLane({
      outputRoot: OUTPUT_ROOT, homeDirectory: HOME_DIRECTORY, redactor,
      onSessionOpened: (message, sessionId) => emit("lifecycle", message, {
        safeData: { event: "terminal_session_opened", sessionId },
      }),
      onLogStopped: (message, sessionId) => emit("warning", message, {
        safeData: { event: "terminal_masking_failed", sessionId },
      }),
      openUrl: (url) => openTerminalUrl(url, { sidecar: () => leg.activitySidecar, environment: () => leg.env }),
      // Its logs' clock is the recording's, so a shell's output lands on the frame it was printed on.
      now: recordingNow,
    }),
    pageMetadata: createPageMetadataPublisher(() => leg.env),
  };
  emit("lifecycle", "Activity started", {
    safeData: {
      event: "activity_runtime_started",
      status: "running",
      kind: activity.kind,
      runtimeMode: "single_session",
      runtimeInstance,
    },
  });
  emit("evidence", activity.repositoryAvailable ? "Repository checkout ready" : "Live product ready", {
    safeData: activity.repositoryAvailable
      ? { commit: activity.repositoryCommitSha, mode: "read_only" }
      : { mode: "production_url_only" },
  });
  try {
    const { authStatePath, signInStateSource, entry } = await openActivityBrowser(activity, leg, trustedAccess);
    await registerRuntimeSecrets(registerSecret, { statePath: authStatePath });
    const challenge = await inspectCloudflareChallenge(leg.env);
    if (challenge) {
      await publishCloudflareBlocked(challenge);
      return;
    }
    await leg.pageMetadata.publish("initial").catch(() => undefined);
    emit("evidence", "Production opened", { safeData: { origin: new URL(activity.productionUrl).origin } });
    await sizeActivityBrowserWindow(leg.env, runtimeInstance);
    const streamStack = await startActivityStreamStack({ cdpUrl: leg.browser.cdpUrl, terminalLane: leg.terminalLane, runtimeInstance });
    leg.activitySidecar = streamStack.sidecar;
    // The host asked for the walk's screen: recorded from the sidecar's first frame (walk-recording.mjs).
    if (activity.recordScreen) await startWalkRecording({ upstreamPort: leg.activitySidecar.port, terminalLane: leg.terminalLane });
    // The first frame: judged with the stream up and the agent asleep;
    // the leg's entry check is armed alongside it.
    const opening = await openingFrameContext({
      activity, env: leg.env, authStatePath, signInStateSource, entry, pagesSeen: leg.pageMetadata.pagesSeen,
    });
    const { turn, publicMessages } = await runAgentTurn({ activity, leg, opening, assistantFeed: streamStack.assistantFeed });
    // The agent's turn is over, so its shells close now: their logs are masked
    // before anything reads them, as a Journey's are.
    await leg.terminalLane.close().catch(() => {});
    await deliverActivityResult({ activity, leg, turn, publicMessages, authStatePath });
  } finally {
    // A one-time code's blackout ends with the leg, after its evidence is kept.
    await releaseActivityResources(leg).finally(endScreencastBlackout);
  }
}
