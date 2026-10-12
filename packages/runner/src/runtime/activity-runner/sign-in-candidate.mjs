// The leg-end sign-in candidate: the browser's state read over the agent
// browser's own CDP endpoint, sealed, and written as the candidate the host
// promotes only past two gates — the writeback regression guard against the
// state the leg loaded, and the product-page ruler the takeover viewer seals
// by — with the refusal that keeps a failed capture as evidence instead.
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { signInRefusalMessage } from "@shipbash/contracts/runtime/sign-in-scope.mjs";

import { captureBrowserState, cdpBaseUrl } from "../browser-state-capture.mjs";
import { sealBrowserState } from "../browser-state-seal.mjs";
import { signInStateSecrets } from "../runtime-secrets.mjs";

import { judgeInlineCandidate } from "./auth-candidate-ruler.mjs";
import { agentBrowser } from "./browser.mjs";
import { AUTH_CANDIDATE_PATH, AUTH_CANDIDATE_READY_PATH, AUTH_CANDIDATE_SCOPE_PATH, AUTH_ROOT } from "./environment.mjs";
import { captureFirstFrame } from "./first-frame.mjs";
import { assessSignInWriteback, readLoadedState, writebackBaselinePath } from "./sign-in-writeback.mjs";
import { registerSecret } from "./redaction.mjs";
import { emit } from "./state.mjs";

/** A refused capture is kept here as evidence, beside the candidate and never in its place. */
const AUTH_CANDIDATE_REFUSED_PATH = join(AUTH_ROOT, "candidate.refused.json.enc");
/**
 * Refusals that prove the session this leg loaded is dead. A takeover's
 * ready marker must not survive one of these: the host promotes on that
 * marker for any leg that did not end unauthenticated (control-plane's
 * settleActivitySignIn), and the bytes under it are the session the leg
 * just lost.
 * "No product page" proves nothing (the agent may have ended on another
 * site) and a failed save is a fault, so those leave the marker as it was.
 */
const PROVEN_DEAD_REASONS = new Set([
  "session_cookies_dropped", "sign_in_storage_dropped", "sign_in_surface", "no_product_storage",
]);

/**
 * The refusal shared by both gates: the refused capture is kept as
 * evidence beside the candidate, a refusal that proved the loaded session
 * dead takes a takeover's leftover ready marker with it, and the event says
 * which reason and whether the marker went.
 * @returns {Promise<false>}
 */
async function refuseSignInState({ reason, message, source, sealed }) {
  await writeFile(AUTH_CANDIDATE_REFUSED_PATH, sealed, { mode: 0o600 }).catch(() => undefined);
  const readyCleared = PROVEN_DEAD_REASONS.has(reason) && existsSync(AUTH_CANDIDATE_READY_PATH);
  if (readyCleared) await rm(AUTH_CANDIDATE_READY_PATH, { force: true });
  emit("warning", "Sign-in state not written", {
    bodyMarkdown: message,
    safeData: { event: "sign_in_state_not_written", reason, source, readyCleared },
  });
  return false;
}

/**
 * The refusal's sentence for the timeline. A leg that took over mid-way
 * (source "handoff") had someone at the browser, so it keeps the takeover
 * viewer's own words; a steady-state leg's end had nobody there to "save
 * again", so it says where the leg ended and that the saved state was kept.
 * @param {"leg_end" | "handoff"} source
 * @param {ReturnType<typeof import("@shipbash/contracts/runtime/sign-in-scope.mjs").readSignInScope>} scope
 * @param {string} productHost
 */
export function signInStateRefusalMessage(source, scope, productHost) {
  if (source === "handoff") return signInRefusalMessage(scope, productHost);
  const kept = "the saved sign-in state was kept.";
  if (scope.reason === "no_product_page") return `This leg ended with no page of ${productHost} open or answering; ${kept}`;
  if (scope.reason === "sign_in_surface") {
    return `This leg ended on the sign-in surface of ${productHost} (${scope.page?.url ?? ""}); ${kept}`;
  }
  return `This leg ended with nothing of ${productHost}'s stored in its browser; ${kept}`;
}

/**
 * Saves the browser's sign-in state as the candidate the host promotes, and
 * marks it ready only once two gates pass: the regression guard against the
 * state the leg loaded (after a takeover on this browser, the takeover's own
 * capture), and the same ruler the takeover viewer seals by — the product
 * page past its sign-in surface, with something of the product's to save.
 * The state is the ShipBash document the viewer seals too, read over
 * the agent browser's own CDP endpoint (`get cdp-url`) — cookies with every
 * field, each origin's localStorage, sessionStorage and IndexedDB — so the
 * next leg restores the same things whichever lane captured them. The
 * document now carries sessionStorage and IndexedDB values, so it is only
 * ever written sealed: a lane without its key seals nothing. The scope goes
 * beside the candidate as it does for the viewer.
 * The candidate path is written only past both gates, so a refusal leaves
 * whatever it held (a takeover's own capture, after a resume) untouched.
 *
 * @param {Record<string, string | undefined>} env The agent-browser environment.
 * @param {string} productionUrl The product URL the Activity opened on.
 * @param {{ source?: "leg_end" | "handoff", authStatePath?: string | null }} [context] Why this leg is writing back and the state it loaded.
 * @param {{
 *   agentBrowser: Function, captureFirstFrame: Function, captureOptions?: { pageTimeoutMs?: number },
 *   judge?: ReturnType<typeof import("../page-kind.mjs").pageJudge>,
 * }} [io]
 *   The browser commands, the capture's options and the page's judge (Jev
 *   with the key in `env` by default); fakes may be handed in.
 * @returns {Promise<boolean>} True when the state was written ready; false when a regression skipped it.
 */
export async function saveActivityAuthCandidate(env, productionUrl, { source = "leg_end", authStatePath = null } = {}, io = { agentBrowser, captureFirstFrame }) {
  const encryptionKey = env.AGENT_BROWSER_ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error("The Activity has no encryption key to seal the sign-in state with.");
  const cdpReply = await io.agentBrowser(["get", "cdp-url"], env, { cancelable: false, timeoutMs: 15_000 });
  const { state, unanswered } = await captureBrowserState(cdpBaseUrl(cdpReply), { label: "Agent browser", ...io.captureOptions });
  for (const secret of signInStateSecrets(state)) registerSecret(secret);
  const sealed = sealBrowserState(state, encryptionKey);
  // Gate one: a logged-out leg must never overwrite a good saved session.
  const writeback = assessSignInWriteback({
    before: await readLoadedState(writebackBaselinePath(source, authStatePath), encryptionKey),
    after: state,
    sealed,
    productionUrl,
  });
  if (writeback.regression) {
    return refuseSignInState({
      reason: writeback.regression,
      message: "This leg ended without the product's session it started with; the saved sign-in state was kept.",
      source,
      sealed,
    });
  }
  // Gate two: the product page past its sign-in surface, with something of the product's to save.
  const scope = await judgeInlineCandidate(io, env, productionUrl, state, unanswered);
  await writeFile(AUTH_CANDIDATE_SCOPE_PATH, `${JSON.stringify(scope)}\n`, { mode: 0o600 })
    .catch(() => undefined);
  if (!scope.product) {
    return refuseSignInState({
      reason: scope.reason, message: signInStateRefusalMessage(source, scope, new URL(productionUrl).hostname), source, sealed,
    });
  }
  await writeFile(`${AUTH_CANDIDATE_PATH}.enc`, sealed, { mode: 0o600 });
  await rm(AUTH_CANDIDATE_PATH, { force: true });
  await writeFile(AUTH_CANDIDATE_READY_PATH, `${new Date().toISOString()}\n`, { mode: 0o600 });
  emit("evidence", "Sign-in state written", {
    safeData: {
      event: "sign_in_state_written",
      stateVersion: writeback.stateVersion,
      source,
      productEntries: scope.productCookies + scope.productOrigins,
      newEntries: writeback.newEntries,
    },
  });
  return true;
}
