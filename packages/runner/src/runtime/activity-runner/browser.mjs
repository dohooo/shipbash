import { DESKTOP_BROWSER_ENV } from "../desktop-browser.mjs";
// The Activity runner's browser lane wiring: the clean single-session
// environment, the agent-browser CLI facade that joins the harness's browser
// (harness-browser.mjs), activity evidence capture, and the stream gateway.
import { createHash } from "node:crypto";

import { LANE_WEBMCP_ENV } from "@shipbash/contracts/runtime/browser-lane.mjs";

import { createActivityEvidence } from "../activity-evidence.mjs";
import { createAgentBrowserCli } from "../agent-browser-cli.mjs";
import { indexedDbRestoreSummary } from "../browser-state-restore.mjs";
import { createControlLeaseReader } from "../control-lease-reader.mjs";
import { createStreamLane } from "../stream-lane.mjs";

import {
  HOME_DIRECTORY,
  HUMAN_AUTH_CONTROL_LEASE_PATH,
  OUTPUT_ROOT,
  POINTER_CHANNEL_PATH,
  STDERR_TAIL_BYTES,
  WORK_DIRECTORY,
} from "./environment.mjs";
import { redactString } from "./redaction.mjs";
import { CancellationError, emit } from "./state.mjs";
import { runProcess } from "./processes.mjs";

export function cleanEnvironment(activity) {
  const env = { ...process.env };
  for (const key of [
    "AGENT_BROWSER_ACTION_POLICY",
    "AGENT_BROWSER_ALLOWED_DOMAINS",
    "AGENT_BROWSER_CONFIRM_ACTIONS",
    "AGENT_BROWSER_CONFIRM_INTERACTIVE",
    "AGENT_BROWSER_PROFILE",
    "AGENT_BROWSER_STATE",
    "AI_GATEWAY_API_KEY",
    "SHIPBASH_BROWSER_STREAM_URL",
    "SHIPBASH_BROWSER_STREAM_PATH",
    "SHIPBASH_BROWSER_STREAM_ALLOWED_ORIGIN",
    "SHIPBASH_BROWSER_STREAM_PUBLIC_PORT",
    "SHIPBASH_STREAM_UPSTREAM_CHANNEL",
  ]) delete env[key];
  const digest = createHash("sha256").update(activity.activityId).digest("hex").slice(0, 16);
  return {
    ...env,
    HOME: HOME_DIRECTORY,
    ...DESKTOP_BROWSER_ENV,
    AGENT_BROWSER_SOCKET_DIR: "/run/agent-browser",
    AGENT_BROWSER_NAMESPACE: `activity-${digest}`,
    AGENT_BROWSER_SESSION: `activity-${digest}`,
    AGENT_BROWSER_CONTENT_BOUNDARIES: "true",
    AGENT_BROWSER_MAX_OUTPUT: "20000",
    // State capture is harness-owned; the daemon must never autosave over it.
    AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0",
    ...LANE_WEBMCP_ENV,
    AGENT_BROWSER_SCREENSHOT_DIR: OUTPUT_ROOT,
    SHIPBASH_POINTER_CHANNEL: POINTER_CHANNEL_PATH,
  };
}

/** Reader for the takeover control-lease token the sidecar gates this Activity's viewer input on. */
export function activityControlLeaseReader() {
  return createControlLeaseReader(HUMAN_AUTH_CONTROL_LEASE_PATH);
}

// The outcome of this leg's sign-in state restore, kept for the first-frame
// judgment: a state that did not load is a harness fault, not a wall.
let lastSignInStateLoad = null;
/** @returns {{ loaded: boolean } | null} */
export function signInStateRestore() {
  return lastSignInStateLoad;
}

const agentBrowserCli = createAgentBrowserCli({
  runProcess,
  CancellationError,
  stderrTailBytes: STDERR_TAIL_BYTES,
  redactResponseError: (value) => redactString(value).slice(0, 500),
  // The message stays the reader-facing sentence it always was; the
  // machine-readable cause rides along so a caller can report WHY instead
  // of the constant string that made this class of failure undiagnosable.
  commandFailureMessage: (args) => `agent-browser ${args[0] ?? "command"} did not complete.`,
  desktop: true,
  unwrapJson: true,
  openFlow: {
    // The restore's outcome on the record, where an expired or missing
    // sign-in used to be indistinguishable from a swapped browser.
    onStateLoaded: () => {
      lastSignInStateLoad = { loaded: true };
      emit("evidence", "Sign-in state loaded", { safeData: { event: "sign_in_state_loaded", loaded: true } });
    },
    // What of the state's IndexedDB went back, on the record beside the
    // load: a Firebase sign-in that did not is the first frame's wall.
    onIndexedDbRestored: (outcome) => {
      emit(outcome.failed.length > 0 ? "warning" : "evidence", "Sign-in IndexedDB restored", {
        safeData: { event: "sign_in_indexeddb_restored", ...indexedDbRestoreSummary(outcome) },
      });
    },
  },
});
export const { agentBrowser, openProductionBrowser, inspectCloudflareChallenge } = agentBrowserCli;
export const agentBrowserDiagnostics = agentBrowserCli.agentBrowserDiagnostics;

const activityEvidence = createActivityEvidence({
  agentBrowser,
  runProcess,
  emit,
  redactString,
  outputRoot: OUTPUT_ROOT,
  pointerChannelPath: POINTER_CHANNEL_PATH,
});
export const {
  captureNarrativeThumbnail,
  startActivityPointerReader,
  readBrowserPageMetadata,
} = activityEvidence;

export const { announceStreamPort, closeStreamGateway } = createStreamLane({
  workDirectory: WORK_DIRECTORY,
  pointerChannelPath: POINTER_CHANNEL_PATH,
});
