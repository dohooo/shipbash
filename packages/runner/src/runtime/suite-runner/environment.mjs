// Environment-derived paths and fixed constants for the suite runner. Every
// module reads its mount points and tunables from here; the ones both runners
// share are declared once, in container-paths.mjs.
import { join } from "node:path";

import { containerPaths } from "../container-paths.mjs";

const paths = containerPaths("suite.json");
export const {
  INPUT_PATH, OUTPUT_ROOT, CONTROL_ROOT, AUTH_ROOT, AUTH_STATE_PATH, AUTH_CANDIDATE_PATH, AUTH_CANDIDATE_READY_PATH,
  CANCEL_PATH, RUNTIME_DIRECTORY, HOME_DIRECTORY, WORK_DIRECTORY, POINTER_CHANNEL_PATH,
} = paths;
export { STDERR_TAIL_BYTES } from "../container-paths.mjs";
// Only the Settings preauthorization container opts out of the journey desktop.
// The host already identifies that isolated browser with this fixed role ID.
export const SIGN_IN_TAKEOVER = process.env.SHIPBASH_BROWSER_ID === "sign-in-takeover";
export const SIGN_IN_LOGIN = process.env.SHIPBASH_BROWSER_ID === "sign-in-login";
export const SIGN_IN_HEADLESS = SIGN_IN_TAKEOVER || SIGN_IN_LOGIN || process.env.SHIPBASH_BROWSER_ID === "sign-in-verify";
export const AUTH_COMPLETE_PATH = join(CONTROL_ROOT, "auth-complete");
export const AUTH_CANCEL_PATH = join(CONTROL_ROOT, "auth-cancel");
// The sign-in takeover's control channel. The host bind-mounts a directory
// here and mints the screencast control lease into it, which is the only
// thing that lets a person drive this browser from the canvas. Without that
// mount the file never appears and the stream stays a read-only mirror.
export const SIGN_IN_CONTROL_ROOT = join(CONTROL_ROOT, "sign-in");
export const SIGN_IN_CONTROL_LEASE_PATH = join(SIGN_IN_CONTROL_ROOT, "control-lease");
// "I'm done": the host drops a request id into its read-only control mount,
// the lane seals what the browser holds into the auth mount beside it, and
// the answer names the same id. Sealed bytes and a separate answer, because
// a reader must never mistake a half-written capture for a finished one.
export const SIGN_IN_CAPTURE_REQUEST_PATH = join(SIGN_IN_CONTROL_ROOT, "capture-request");
export const SIGN_IN_CAPTURE_STATE_PATH = join(AUTH_ROOT, "sign-in-capture.json.enc");
export const SIGN_IN_CAPTURE_ANSWER_PATH = join(AUTH_ROOT, "sign-in-capture.json");
// The verification leg's one-shot mount: the session to prove, read once and
// then deleted by the host, which waits for this marker before deleting.
// Fixed by the container layout: the host mounts the verification leg's
// session and control directories here (init-browser-verify.ts).
export const SIGN_IN_VERIFY_ROOT = join(paths.RUNTIME_ROOT, "sign-in");
export const SIGN_IN_VERIFY_CONFIG_PATH = join(SIGN_IN_VERIFY_ROOT, "config.json");
export const SIGN_IN_VERIFY_CONSUMED_PATH = join(CONTROL_ROOT, "sign-in-verify-consumed");
// The auto-login leg makes a session rather than being handed one, so it
// seals what the browser holds back onto the same writable control mount and
// the host reads it once the leg has said it got in.
export const SIGN_IN_LOGIN_STATE_PATH = join(CONTROL_ROOT, "sign-in-login.json.enc");
export const CASE_SCHEMA_PATH = join(RUNTIME_DIRECTORY, "case-output.schema.json");
export const CODE_EVIDENCE_SCHEMA_PATH = join(RUNTIME_DIRECTORY, "code-evidence-output.schema.json");
// The human-auth Chromium writes into a viewer-scoped disposable profile;
// nothing outside this container ever reads it. Sign-in truth leaves as the
// CDP-captured candidate state, never as profile bytes.
export const HUMAN_AUTH_PROFILE_PATH = join(WORK_DIRECTORY, "human-auth-profile");
export { DESKTOP_DISPLAY as HUMAN_AUTH_DISPLAY, DESKTOP_XDG_PATH as HUMAN_AUTH_XDG_RUNTIME_PATH } from "../desktop-browser.mjs";
export const HUMAN_AUTH_VNC_PORT = 5900;
export const HUMAN_AUTH_WEB_PORT = 6080;
export const HUMAN_AUTH_PASSWORD_PATH = "/tmp/shipbash-human-auth-vnc-password";
export const OUTCOMES = new Set(["passed", "failed", "blocked", "error", "auth_required"]);
export const AUTH_STATES = new Set(["authenticated", "unauthenticated", "unknown"]);
const DEFAULT_AUTH_TAKEOVER_TIMEOUT_MS = 10 * 60_000;
const MIN_AUTH_TAKEOVER_TIMEOUT_MS = 10_000;
const MAX_AUTH_TAKEOVER_TIMEOUT_MS = 60 * 60_000;
export const SENSITIVE_KEY_PATTERN =
  /(?:password|passwd|passphrase|secret|token|authorization|cookie|credential|api[-_]?key|auth[-_]?state)/i;
export const AGENT_BROWSER_MCP_ENV_VARS = Object.freeze([
  "PATH", "HOME",
  // The harness's browser, which every call joins; the proxy refuses to start
  // without it. With it, the one other setting the harness's own calls
  // connect with (contracts browser-lane.mjs LANE_WEBMCP_ENV): a call whose
  // settings differ makes the daemon join the browser again and renumber its
  // element refs.
  "AGENT_BROWSER_CDP",
  "AGENT_BROWSER_NO_WEBMCP",
  "AGENT_BROWSER_NAMESPACE",
  "AGENT_BROWSER_SESSION",
  "AGENT_BROWSER_SOCKET_DIR",
  "AGENT_BROWSER_CONTENT_BOUNDARIES",
  "AGENT_BROWSER_MAX_OUTPUT",
  "AGENT_BROWSER_AUTOSAVE_INTERVAL_MS",
  "AGENT_BROWSER_SCREENSHOT_DIR",
  "SHIPBASH_POINTER_CHANNEL",
]);

export function authTakeoverTimeoutMs(env = process.env) {
  const rawValue = env.SHIPBASH_AUTH_TAKEOVER_TIMEOUT_MS;
  if (rawValue === undefined || rawValue === "") {
    return DEFAULT_AUTH_TAKEOVER_TIMEOUT_MS;
  }
  const value = Number(rawValue);
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_AUTH_TAKEOVER_TIMEOUT_MS ||
    value > MAX_AUTH_TAKEOVER_TIMEOUT_MS
  ) {
    throw new Error(
      `SHIPBASH_AUTH_TAKEOVER_TIMEOUT_MS must be an integer between ${MIN_AUTH_TAKEOVER_TIMEOUT_MS} and ${MAX_AUTH_TAKEOVER_TIMEOUT_MS}.`,
    );
  }
  return value;
}

/**
 * Full Chrome traces are heavy to capture and were implicated in an
 * out-of-memory Runner death, so they stay off unless explicitly requested.
 * Browser video recordings are unaffected.
 */
export function chromeTraceEnabled(env = process.env) {
  const value = String(env.SHIPBASH_CHROME_TRACE ?? "")
    .trim()
    .toLowerCase();
  return value === "1" || value === "true";
}
