// The suite lane's steady-state sign-in writeback. Every case runs in its own
// fresh browser initialised from the saved state, so the session cookies the
// product rotates during a case die with that case's browser unless captured
// before it closes. In a run that injected a state and never took over, every
// case that reached a passed/failed verdict without ending at a login gate
// captures its browser's state over the browser's own CDP endpoint — the
// ShipBash document, with sessionStorage and IndexedDB, the same capture
// every other lane makes — and seals it as the candidate the host promotes
// at run end, each case overwriting the last so the newest wins. The agent's
// authState only flags the gate it saw ("unauthenticated"); whether the
// session is alive is judged here, by the state and the page: the guards
// refuse an anonymous or logged-out state, and one whose case ended off the
// product's site or on its sign-in surface, and a refusal writes nothing,
// so an earlier case's candidate stands.
import { rm, writeFile } from "node:fs/promises";

import {
  productStateEntryCount,
  signInBaselineDiff,
  signInStateRegression,
} from "@shipbash/contracts/runtime/sign-in-scope.mjs";

import { captureBrowserState, cdpBaseUrl } from "../browser-state-capture.mjs";
import { readBrowserStateFile, sealBrowserState, sealedStateVersion } from "../browser-state-seal.mjs";
import { pageJudge } from "../page-kind.mjs";
import { signInStateSecrets } from "../runtime-secrets.mjs";
import { AUTH_CANDIDATE_PATH } from "./environment.mjs";
import { agentBrowser } from "./browser.mjs";
import { PAGE_READING_FIELDS, pageReadingFrom, productPageVerdict } from "./human-auth-page.mjs";
import { registerSecret } from "./redaction.mjs";
import { emit } from "./state.mjs";

/** Records why this case's state was not promoted; returns false. */
function skipWriteback(reason) {
  emit("case", "sign_in_state_not_written", { reason });
  return false;
}

/**
 * The session lost or the page wrong, or null: the regression guard against
 * the state the case loaded, then the page the case ended on — off the
 * product's site, still its sign-in surface, or not judged at all — which
 * the cookies cannot tell from a live session when the product keeps them
 * across a sign-out. The same verdict the takeover capture and the Activity
 * lane's ruler read; a page Jev did not judge writes nothing, so the saved
 * state stands.
 */
async function signInStateRefusal(before, state, answers, productionUrl, judge) {
  const regression = before ? signInStateRegression(before, state, productionUrl) : null;
  if (regression) return regression;
  const { verdict, unjudged } = await productPageVerdict(answers.map((answer) => pageReadingFrom(answer)), productionUrl, judge);
  if (verdict === null) return unjudged.length > 0 ? "page_unjudged" : "no_product_page";
  return verdict.signInSurface ? "sign_in_surface" : null;
}

/**
 * Captures the current case browser's sign-in state as the run's promotion
 * candidate, when it is worth promoting. Called with the case browser still
 * open, before its teardown. Never throws — a capture fault is a warning, not a
 * case failure. Returns whether a candidate was written for the host to promote.
 *
 * @param {{
 *   result: { outcome: string, authState: string },
 *   env: Record<string, string | undefined>,
 *   productionUrl: string,
 *   beforePath: string | null,
 *   judge?: ReturnType<typeof pageJudge>,
 * }} input `judge` defaults to Jev with the key in `env`.
 * @returns {Promise<boolean>}
 */
export async function retainSuiteSignInState({ result, env, productionUrl, beforePath, judge = pageJudge(env) }) {
  // No state injected means nothing to write back: a case's own word that it
  // is signed in is not a sign-in the project can keep.
  if (beforePath === null) return false;
  if (result.authState === "unauthenticated" || (result.outcome !== "passed" && result.outcome !== "failed")) {
    return false;
  }
  const encryptionKey = env.AGENT_BROWSER_ENCRYPTION_KEY;
  if (!encryptionKey) return skipWriteback("no_encryption_key");
  try {
    const cdpReply = await agentBrowser(["get", "cdp-url"], env, { cancelable: false, timeoutMs: 15_000 });
    const { state, answers } = await captureBrowserState(cdpBaseUrl(cdpReply), { label: "Case browser", pageFields: PAGE_READING_FIELDS });
    for (const secret of signInStateSecrets(state)) registerSecret(secret);
    const counts = productStateEntryCount(state, productionUrl);
    if (counts.cookies + counts.origins === 0) return skipWriteback("no_product_storage");
    const before = await readBrowserStateFile(beforePath, encryptionKey).catch(() => null);
    const refusal = await signInStateRefusal(before, state, answers, productionUrl, judge);
    if (refusal) return skipWriteback(refusal);
    const sealed = sealBrowserState(state, encryptionKey);
    await writeFile(`${AUTH_CANDIDATE_PATH}.enc`, sealed, { mode: 0o600 });
    await rm(AUTH_CANDIDATE_PATH, { force: true });
    emit("case", "sign_in_state_written", {
      stateVersion: sealedStateVersion(sealed),
      source: "leg_end",
      productEntries: counts.cookies + counts.origins,
      newEntries: before ? signInBaselineDiff(before, state, productionUrl).length : null,
    });
    // The host promotes candidate.json.enc at run end, under the Run's own
    // state-version compare-and-swap; the same event the takeover lane raises.
    emit("case", "auth_state_promoted", { validationRound: 0, path: `${AUTH_CANDIDATE_PATH}.enc` });
    return true;
  } catch {
    return skipWriteback("capture_failed");
  }
}
