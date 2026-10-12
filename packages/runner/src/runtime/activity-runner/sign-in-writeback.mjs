// The leg-end sign-in writeback assessment. The capture, the seal and the
// product-page ruler live in results.mjs; this judges the state the leg
// loaded against the one it just captured, on the shared sign-in ruler: the
// regression guard that refuses to overwrite a good session with a
// logged-out leg's, plus the version and baseline-diff facts the
// sign_in_state_written event carries.
import { existsSync } from "node:fs";

import { signInBaselineDiff, signInStateRegression } from "@shipbash/contracts/runtime/sign-in-scope.mjs";

import { readBrowserStateFile, sealedStateVersion } from "../browser-state-seal.mjs";

import { AUTH_CANDIDATE_PATH, AUTH_CANDIDATE_READY_PATH } from "./environment.mjs";

/**
 * The state a leg's end is measured against. A leg that filed a sign-in
 * request and got a takeover on this very browser loaded the state that
 * needed it, so the takeover's own ready capture in the task directory is the
 * session to compare with: measured against the dead state, an httpOnly
 * cookie it carried and the fresh sign-in never set would read as a regression
 * and cost the person's login. Every other leg is measured against what it
 * loaded; so is a handoff leg whose takeover left no ready candidate.
 * @param {"leg_end" | "handoff"} source @param {string | null} authStatePath
 * @returns {string | null}
 */
export function writebackBaselinePath(source, authStatePath) {
  const candidatePath = `${AUTH_CANDIDATE_PATH}.enc`;
  if (source === "handoff" && existsSync(candidatePath) && existsSync(AUTH_CANDIDATE_READY_PATH)) return candidatePath;
  return authStatePath;
}

/**
 * The state the leg loaded, or null when it loaded none or the file cannot
 * be opened: a state that cannot be read is not compared against, and the
 * page ruler still decides.
 * @param {string | null} path @param {string | undefined} encryptionKey
 */
export async function readLoadedState(path, encryptionKey) {
  if (path === null) return null;
  return readBrowserStateFile(path, encryptionKey).catch(() => null);
}

/**
 * @param {{ before: unknown, after: unknown, sealed: Uint8Array, productionUrl: string }} input
 *   `before` is the loaded state, or null when the leg loaded none; `after` the captured one; `sealed` its bytes on disk.
 * @returns {{ regression: string | null, stateVersion: string, newEntries: number | null }}
 */
export function assessSignInWriteback({ before, after, sealed, productionUrl }) {
  const regression = before ? signInStateRegression(before, after, productionUrl) : null;
  const newEntries = before ? signInBaselineDiff(before, after, productionUrl).length : null;
  return { regression, stateVersion: sealedStateVersion(sealed), newEntries };
}
