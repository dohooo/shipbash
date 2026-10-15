import { DESKTOP_BROWSER_ENV } from "../desktop-browser.mjs";
// The suite runner's browser lane wiring: the clean per-case environment,
// the agent-browser CLI facade that joins the harness's browser
// (harness-browser.mjs), case artifact capture, and the stream gateway.
import { createHash } from "node:crypto";

import { LANE_WEBMCP_ENV } from "@shipbash/contracts/runtime/browser-lane.mjs";

import { createAgentBrowserCli } from "../agent-browser-cli.mjs";
import { indexedDbRestoreSummary } from "../browser-state-restore.mjs";
import { createCaseArtifacts } from "../case-artifacts.mjs";
import { createStreamLane } from "../stream-lane.mjs";

import {
  HOME_DIRECTORY,
  OUTPUT_ROOT,
  POINTER_CHANNEL_PATH,
  STDERR_TAIL_BYTES,
  SIGN_IN_HEADLESS,
  WORK_DIRECTORY,
} from "./environment.mjs";
import { redactEventValue, safeError } from "./redaction.mjs";
import { CancellationError, emit } from "./state.mjs";
import { runProcess } from "./processes.mjs";

export function cleanBrowserEnvironment(overrides = {}) {
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
  ]) {
    delete env[key];
  }
  const browserEnv = {
    ...env,
    HOME: HOME_DIRECTORY,
    AGENT_BROWSER_SOCKET_DIR: "/run/agent-browser",
    AGENT_BROWSER_CONTENT_BOUNDARIES: "true",
    AGENT_BROWSER_MAX_OUTPUT: "20000",
    // State capture is harness-owned; the daemon must never autosave over it.
    AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0",
    ...LANE_WEBMCP_ENV,
    SHIPBASH_POINTER_CHANNEL: POINTER_CHANNEL_PATH,
    ...overrides,
    ...DESKTOP_BROWSER_ENV,
  };
  if (SIGN_IN_HEADLESS) {
    for (const key of Object.keys(DESKTOP_BROWSER_ENV)) delete browserEnv[key];
  }
  return browserEnv;
}

const agentBrowserCli = createAgentBrowserCli({
  desktop: !SIGN_IN_HEADLESS,
  runProcess,
  CancellationError,
  stderrTailBytes: STDERR_TAIL_BYTES,
  redactResponseError: (value) => String(redactEventValue(value)).slice(0, 500),
  commandFailureMessage: (args, result) => (result.timedOut
    ? `agent-browser ${args[0] ?? "command"} timed out.`
    : `agent-browser ${args[0] ?? "command"} exited with code ${result.code}.`),
  openFlow: {
    onIndexedDbRestored: (outcome) =>
      emit("browser", "sign_in_indexeddb_restored", { mode: "case", ...indexedDbRestoreSummary(outcome) }),
  },
});
export const { agentBrowser, inspectCloudflareChallenge } = agentBrowserCli;
export const agentBrowserDiagnostics = agentBrowserCli.agentBrowserDiagnostics;
export const openProductionBrowser = agentBrowserCli.openProductionBrowser;

const caseArtifacts = createCaseArtifacts({
  agentBrowser,
  emit,
  safeError,
  redactEventValue,
  outputRoot: OUTPUT_ROOT,
});
export const {
  nonEmptyFile,
  writeFailureDiagnostics,
  captureArtifacts,
} = caseArtifacts;
export const serializeRedactedJsonArtifact = caseArtifacts.serializeRedactedJsonArtifact;
export const sanitizeCaseResultCopy = caseArtifacts.sanitizeCaseResultCopy;
export const caseArtifactDirectory = caseArtifacts.caseArtifactDirectory;

export const { announceStreamPort, closeStreamGateway, viewerCount } = createStreamLane({
  workDirectory: WORK_DIRECTORY,
  pointerChannelPath: POINTER_CHANNEL_PATH,
});

export function browserEnvironment(
  caseRunId,
  attempt,
  executionRound,
  artifactDirectory,
) {
  const digest = createHash("sha256")
    .update(`${caseRunId}:${attempt}:${executionRound}`)
    .digest("hex")
    .slice(0, 16);
  return cleanBrowserEnvironment({
    AGENT_BROWSER_NAMESPACE: `case-${digest}`,
    AGENT_BROWSER_SESSION: `case-${digest}`,
    AGENT_BROWSER_SCREENSHOT_DIR: artifactDirectory,
  });
}
