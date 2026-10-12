// Environment-derived paths and fixed constants for the Activity runner.
// Every module reads its mount points and tunables from here; the ones both
// runners share are declared once, in container-paths.mjs.
import { join } from "node:path";

import { validateActivity as validateActivityInput } from "@shipbash/contracts/runtime/activity-contracts.mjs";
import { ACTIVITY_EVENT_KINDS } from "@shipbash/contracts/runtime/event-contract.mjs";
import { absoluteEnvironmentPath, containerPaths } from "../container-paths.mjs";

const paths = containerPaths("activity.json");
export const {
  INPUT_PATH, OUTPUT_ROOT, CONTROL_ROOT, AUTH_ROOT, AUTH_STATE_PATH, AUTH_CANDIDATE_PATH, AUTH_CANDIDATE_READY_PATH,
  CANCEL_PATH, RUNTIME_DIRECTORY, HOME_DIRECTORY, WORK_DIRECTORY, REPOSITORY_ROOT,
  POINTER_CHANNEL_PATH,
} = paths;
export { STDERR_TAIL_BYTES } from "../container-paths.mjs";
// The container's reading of the page a sign-in was captured on
// (sign-in-scope.mjs), kept beside the sealed bytes by the host: the
// candidate's from the takeover or the last leg, the state's from the
// version the host seeded.
export const AUTH_STATE_SCOPE_PATH = join(AUTH_ROOT, "state.scope.json");
export const AUTH_CANDIDATE_SCOPE_PATH = join(AUTH_ROOT, "candidate.scope.json");
export const HUMAN_AUTH_ROOT = join(CONTROL_ROOT, "human-auth");
export const HUMAN_AUTH_REQUEST_PATH = join(HUMAN_AUTH_ROOT, "request");
export const HUMAN_AUTH_COMPLETE_PATH = join(HUMAN_AUTH_ROOT, "complete");
export const HUMAN_AUTH_CANCEL_PATH = join(HUMAN_AUTH_ROOT, "cancel");
export const HUMAN_AUTH_RESUMED_PATH = join(HUMAN_AUTH_ROOT, "resumed");
// The server mints a control-lease token here when the user takes over and
// removes it when the takeover ends; the sidecar honors viewer input only
// while a presented token matches this file. Same channel as the sentinels.
export const HUMAN_AUTH_CONTROL_LEASE_PATH = join(HUMAN_AUTH_ROOT, "control-lease");
export const HUMAN_AUTH_UPLOADS_ROOT = join(HUMAN_AUTH_ROOT, "uploads");
export const TAKEOVER_DOWNLOADS_ROOT = "/tmp/shipbash-takeover-downloads";
export const RESULT_PATH = join(OUTPUT_ROOT, "activity-result.json");
export const AGENT_RESULT_PATH = join(WORK_DIRECTORY, "activity-agent-result.json");
export const PROGRESS_PATH = join(WORK_DIRECTORY, "activity-progress.jsonl");
// A recorded walk's subtitles (publish_narration), the video row's channel.
export const NARRATION_PATH = join(WORK_DIRECTORY, "activity-narration.jsonl");
export const FINAL_SCREENSHOT_PATH = join(OUTPUT_ROOT, "activity-final.jpg");
export const OUTPUT_SCHEMA_PATH = join(RUNTIME_DIRECTORY, "activity-output.schema.json");
// The pi session engine's persistent surface: the conversation transcript,
// mounted, so a later leg resumes the SAME session. pi's agent directory is
// not kept here: each leg's is made fresh (pi-sdk.mjs openAgentSession).
export const PI_SESSION_DIRECTORY = absoluteEnvironmentPath("SHIPBASH_PI_SESSION_ROOT", join(paths.RUNTIME_ROOT, "pi-session"));
export { DESKTOP_DISPLAY as HUMAN_AUTH_DISPLAY, DESKTOP_XDG_PATH as HUMAN_AUTH_XDG_RUNTIME_PATH } from "../desktop-browser.mjs";
export const HUMAN_AUTH_PASSWORD_PATH = "/tmp/shipbash-activity-vnc-password";
export const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 90 * 60_000;
export const HUMAN_AUTH_TOOL_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1_000;
// The per-leg ceiling on tool_summary rows: each browser call now writes a
// started row and an agent_action completion, alongside the knowledge and auth
// rows the progress reader emits. The browser emitter only writes a started row
// when its completion also fits under this ceiling, so the cap never strands a
// live row without its completion. Raised alongside the started half so the
// browser-call budget stayed near its previous ~400.
export const MAX_TOOL_SUMMARY_EVENTS = 800;
export const EVENT_KINDS = new Set(ACTIVITY_EVENT_KINDS);
export const SENSITIVE_KEY_PATTERN =
  /(?:password|passwd|passphrase|secret|token|authorization|cookie|credential|api[-_]?key|auth[-_]?state)/iu;
export const AGENT_BROWSER_MCP_ENV_VARS = Object.freeze([
  // The harness's browser, which every call joins; the proxy refuses to start
  // without it. With it, the one other setting the harness's own calls
  // connect with (contracts browser-lane.mjs LANE_WEBMCP_ENV): a call whose
  // settings differ makes the daemon join the browser again and renumber its
  // element refs.
  "AGENT_BROWSER_CDP",
  "AGENT_BROWSER_NO_WEBMCP",
  "AGENT_BROWSER_NAMESPACE",
  "AGENT_BROWSER_SESSION",
  // The leg's daemon lives where the container says it does (/run/agent-browser).
  "AGENT_BROWSER_SOCKET_DIR",
  "AGENT_BROWSER_CONTENT_BOUNDARIES",
  "AGENT_BROWSER_MAX_OUTPUT",
  "AGENT_BROWSER_AUTOSAVE_INTERVAL_MS",
  "AGENT_BROWSER_SCREENSHOT_DIR",
  "SHIPBASH_POINTER_CHANNEL",
  // The proxy derives the wrap-up and page-note paths from the control root.
  "SHIPBASH_CONTROL_ROOT",
]);

/** The Activity contract bound to this container's checkout mount point. */
export function validateActivity(value) {
  return validateActivityInput(value, REPOSITORY_ROOT);
}

// A hosted Sandbox is deleted at its deadline whatever the leg is doing; the
// leg closes this much earlier, leaving room for the agent's abort, the
// result write, and the completion webhook.
const WALL_CLOCK_RESERVE_MS = 3 * 60_000;

/**
 * When the hosted Sandbox running this leg will be deleted, as epoch
 * milliseconds. The dispatcher stamps it into the Sandbox's environment at
 * the fork that starts its lifetime (vercel-sandbox-dispatch/acquire.ts), so
 * the ceiling is measured from the Sandbox's birth and not from whenever the
 * runner got going. Null when unset: the local Docker path has no deadline.
 * @returns {number | null}
 */
export function activityDeadlineAt(env = process.env) {
  const raw = env.SHIPBASH_DISPATCH_DEADLINE_AT;
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("SHIPBASH_DISPATCH_DEADLINE_AT must be an epoch time in milliseconds.");
  }
  return value;
}

/** Milliseconds left until the Sandbox deadline (negative once past); null without one. */
export function activityDeadlineRemainingMs(env = process.env, now = Date.now()) {
  const deadlineAt = activityDeadlineAt(env);
  return deadlineAt === null ? null : deadlineAt - now;
}

/**
 * The wall-clock ceiling on a leg: the budget stops while the owner is being
 * waited on, but the Sandbox is deleted at its deadline regardless, so the
 * leg must close on its own before then. What is left of the deadline less
 * the reserve; null without a deadline, and null when too little is left to
 * close under — the caller says so, and the teardown is then the only end.
 * @returns {number | null}
 */
export function activityWallMs(env = process.env, now = Date.now()) {
  const remaining = activityDeadlineRemainingMs(env, now);
  if (remaining === null) return null;
  const wallMs = remaining - WALL_CLOCK_RESERVE_MS;
  return wallMs >= MIN_TIMEOUT_MS ? wallMs : null;
}

