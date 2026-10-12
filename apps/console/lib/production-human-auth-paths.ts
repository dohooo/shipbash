/**
 * Where a sign-in handoff keeps its state inside its Sandbox, and how long
 * each part of it lives.
 *
 * The handoff writes the Sandbox's auth directory and then reads back what
 * the viewer captured there, so one module owns the layout: the runner's
 * human-auth lane and the code reading its result can never disagree about
 * a path.
 */
export const AUTH_ROOT = "/shipbash/auth";
/** The Project's saved sign-in, sealed under the Sandbox's key, for the viewer to continue from. */
export const STATE_PATH = `${AUTH_ROOT}/state.json.enc`;
export const ENCRYPTION_KEY_PATH = `${AUTH_ROOT}/encryption-key`;
/** What the viewer captured on the way down, sealed under the same key, and the marker that it was the product's sign-in. */
export const CANDIDATE_PATH = `${AUTH_ROOT}/candidate.json.enc`;
export const CANDIDATE_READY_PATH = `${AUTH_ROOT}/candidate.ready`;
export const CONTROL_ROOT = "/shipbash/control/human-auth";
/** The browser lane's working directory and home, for the handoff's viewer and the takeover's browser alike. */
export const WORK_DIRECTORY = "/shipbash/work";
export const HOME_DIRECTORY = "/shipbash/home";
export const HANDOFF_TIMEOUT_MS = 15 * 60 * 1_000;
export const COMMAND_STOP_TIMEOUT_MS = 30_000;
/** How long a claimed handoff may go without a viewer before it counts as abandoned by a dead Function. */
export const CLAIM_GRACE_MS = 5 * 60 * 1_000;
