// CDP capture of the human-auth viewer's signed-in state. Sign-in truth
// leaves the viewer as a sealed ShipBash browser state candidate — cookies
// with every field, and each origin's localStorage, sessionStorage and
// IndexedDB, read over CDP — never as profile bytes. The CDP conversation
// itself is human-auth-cdp.mjs; the anonymous baseline the capture is diffed
// against is human-auth-baseline.mjs; the product page's verdict, which
// decides, is human-auth-page.mjs.
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";
import { normalizeBrowserState } from "@shipbash/contracts/runtime/browser-state.mjs";
import {
  readSignInScope,
  signInBaselineDiff,
  signInRefusalMessage,
} from "@shipbash/contracts/runtime/sign-in-scope.mjs";
import { openBrowserState, sealBrowserState } from "../browser-state-seal.mjs";
import { pageJudge } from "../page-kind.mjs";
import { startTrustedAccessNavigation } from "../trusted-access.mjs";

import {
  AUTH_CANDIDATE_PATH,
  AUTH_CANDIDATE_READY_PATH,
  AUTH_ROOT,
} from "./environment.mjs";
import { nonEmptyFile } from "./browser.mjs";
import { baselineSummary, settledBaseline } from "./human-auth-baseline.mjs";
import { cdpCommand, humanAuthCdpEndpoints, humanAuthStateFromCdp, pageTargets, viewerBrowserCdpUrl } from "./human-auth-cdp.mjs";
import { productPageVerdict } from "./human-auth-page.mjs";

/**
 * A stored cookie as CDP's Storage.setCookies takes it: a session cookie
 * carries no expiry, and sameSite and the partition key go only as they
 * were reported.
 */
function cdpCookieParam(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    ...(cookie.expires > 0 ? { expires: cookie.expires } : {}),
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
  };
}

/**
 * Loads a sealed browser state's cookies into the fresh viewer over CDP.
 * Local storage is not restored: it needs a page on each origin, and the
 * product's is what the person is about to sign into.
 *
 * @param {string} name The sealed file in the auth directory.
 * @param {{ remove: boolean }} options Whether the file goes once read.
 * @returns {Promise<{ loaded: boolean, cookies: number }>}
 */
async function preloadCookies(name, { remove }) {
  const sealedPath = join(AUTH_ROOT, name);
  const sealed = await readFile(sealedPath).catch(() => null);
  if (sealed === null) return { loaded: false, cookies: 0 };
  try {
    const encryptionKey = (await readFile(join(AUTH_ROOT, "encryption-key"), "utf8")).trim();
    const cookies = normalizeBrowserState(openBrowserState(sealed, encryptionKey)).cookies.map(cdpCookieParam);
    if (cookies.length === 0) return { loaded: false, cookies: 0 };
    const { browserSocketUrl } = await humanAuthCdpEndpoints();
    await cdpCommand(browserSocketUrl, "Storage.setCookies", { cookies });
    return { loaded: true, cookies: cookies.length };
  } catch {
    return { loaded: false, cookies: 0 };
  } finally {
    if (remove) await rm(sealedPath, { force: true });
  }
}

/**
 * Loads the Project's saved sign-in into the fresh viewer, so the person
 * continues from the session the tasks have been running on instead of a
 * blank browser. The host seals it as state.json.enc under this Sandbox's
 * key before the viewer starts; the file stays, the Sandbox does not.
 *
 * @returns {Promise<{ loaded: boolean, cookies: number }>}
 */
export function preloadSavedState() {
  return preloadCookies("state.json.enc", { remove: false });
}

/**
 * Loads the capture a refusal left behind into the fresh viewer: its cookies
 * carry the identity provider's session, so the person is not sent through
 * that sign-in a second time — one click on the product's provider button
 * is what remains. The file goes whatever happens; nothing keeps a refused
 * capture around.
 *
 * @returns {Promise<{ loaded: boolean, cookies: number }>}
 */
export function preloadRefusedCandidate() {
  return preloadCookies("candidate.preload.json.enc", { remove: true });
}

export async function startHumanTrustedAccessNavigation(productionUrl, trustedAccess) {
  return startTrustedAccessNavigation(
    { cdpUrl: viewerBrowserCdpUrl() },
    productionUrl,
    trustedAccess,
  );
}

// Diagnostic for the "pasted credentials arrive uppercased" report: records
// only the CapsLock/NumLock LOCK state seen on each keydown — never the key,
// code, or character, so a password can never leak. A session where capsSeen
// is true points at a stuck server lock (case inversion); false-with-uppercase
// points instead at the VNC keysym→keycode translation itself. Best-effort:
// any CDP failure leaves the diagnostic empty and never disrupts the viewer.
const KEYBOARD_DIAGNOSTIC_SCRIPT = `(() => {
  if (window.__sbKbdDiag) return;
  const state = window.__sbKbdDiag = { events: 0, capsSeen: false, numSeen: false };
  addEventListener("keydown", (event) => {
    state.events += 1;
    if (event.getModifierState("CapsLock")) state.capsSeen = true;
    if (event.getModifierState("NumLock")) state.numSeen = true;
  }, true);
})()`;

export async function installKeyboardDiagnostics() {
  try {
    for (const target of await pageTargets()) {
      await cdpCommand(target.webSocketDebuggerUrl, "Page.addScriptToEvaluateOnNewDocument", {
        source: KEYBOARD_DIAGNOSTIC_SCRIPT,
      }).catch(() => undefined);
      await cdpCommand(target.webSocketDebuggerUrl, "Runtime.evaluate", {
        expression: KEYBOARD_DIAGNOSTIC_SCRIPT,
      }).catch(() => undefined);
    }
  } catch {
    // A diagnostic never blocks the viewer coming up.
  }
}

export async function readKeyboardDiagnostics() {
  const summary = { events: 0, capsSeen: false, numSeen: false };
  try {
    for (const target of await pageTargets()) {
      const evaluated = await cdpCommand(target.webSocketDebuggerUrl, "Runtime.evaluate", {
        expression: "JSON.stringify(window.__sbKbdDiag ?? null)",
        returnByValue: true,
      }).catch(() => null);
      const value = evaluated?.result?.value;
      if (typeof value !== "string") continue;
      const parsed = JSON.parse(value);
      if (!isRecord(parsed)) continue;
      summary.events += Number(parsed.events) || 0;
      if (parsed.capsSeen === true) summary.capsSeen = true;
      if (parsed.numSeen === true) summary.numSeen = true;
    }
  } catch {
    // Report whatever was gathered; an unreadable page is not a failure.
  }
  // The container's stdout is not read after startup and the container is
  // --rm, so the summary is persisted into the bind-mounted auth directory,
  // where it survives teardown on the host beside the candidate files.
  await writeFile(
    join(AUTH_ROOT, "keyboard-diagnostic.json"),
    `${JSON.stringify(summary)}\n`,
    { mode: 0o600 },
  ).catch(() => undefined);
  return summary;
}

/** A capture read and found not to be the product's sign-in; the message is for the person. */
export class SignInRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "SignInRefusal";
  }
}

/**
 * Why the capture did not seal, left beside the candidate for the host: a
 * refusal is the person's to fix (sign in to the product, then save), an
 * infrastructure failure is not (the CDP endpoint gone, the key missing),
 * and the host must not answer one with the other's advice.
 */
async function recordCaptureFailure(error) {
  const failure = {
    kind: error instanceof SignInRefusal ? "refusal" : "infrastructure",
    message: error instanceof Error ? error.message : String(error),
  };
  await writeFile(join(AUTH_ROOT, "candidate.failure.json"), `${JSON.stringify(failure)}\n`, { mode: 0o600 })
    .catch(() => undefined);
}

/**
 * Seals what the viewer holds and marks it ready only when it is a sign-in to
 * the product the takeover opened on. Every way it does not is recorded in
 * candidate.failure.json.
 *
 * @param {string} productionUrl The URL the viewer was opened on; its site
 *   and its page are the ruler the capture is judged by.
 * @param {{ pageTimeoutMs?: number, judge?: ReturnType<typeof pageJudge> }} [options]
 *   The capture's page budget and the product page's judge (Jev with this
 *   container's key by default); others may be handed in.
 */
export async function captureConnectedHumanAuthCandidate(productionUrl, options = {}) {
  try {
    await sealCandidate(productionUrl, options);
  } catch (error) {
    await recordCaptureFailure(error);
    throw error;
  }
}

async function sealCandidate(productionUrl, { judge = pageJudge(process.env), ...options }) {
  const encryptionKey = (await readFile(join(AUTH_ROOT, "encryption-key"), "utf8")).trim();
  if (!/^[0-9a-f]{64}$/iu.test(encryptionKey)) {
    throw new Error("The Project authentication encryption key is unavailable.");
  }
  const encryptedPath = `${AUTH_CANDIDATE_PATH}.enc`;
  const { state, pages, unanswered } = await humanAuthStateFromCdp(options);
  await writeFile(
    encryptedPath,
    sealBrowserState(state, encryptionKey),
    { mode: 0o600 },
  );
  await chmod(encryptedPath, 0o600);
  await rm(AUTH_CANDIDATE_PATH, { force: true });
  if (!(await nonEmptyFile(encryptedPath))) {
    throw new Error("agent-browser did not write a non-empty encrypted live auth candidate state.");
  }
  // A viewer nobody signed into still seals a plausible ciphertext, so size
  // cannot be the test, and neither can the cookies: the product's page is
  // (a target product). The bytes stay on disk as evidence of what the
  // viewer held and the scope beside them says what was found — the page
  // verdict, the diff against the anonymous baseline — so the host judges
  // the same way; withholding the ready marker is what keeps the host and
  // the next run from reading them back as a sign-in.
  const baseline = await settledBaseline();
  const { verdict, unjudged } = await productPageVerdict(pages, productionUrl, judge);
  const scope = {
    ...readSignInScope(
      state,
      productionUrl,
      verdict,
      baseline ? signInBaselineDiff(baseline.state, state, productionUrl) : null,
      [...unanswered, ...unjudged],
    ),
    baseline: baselineSummary(baseline),
  };
  await writeFile(
    join(AUTH_ROOT, "candidate.scope.json"),
    `${JSON.stringify(scope)}\n`,
    { mode: 0o600 },
  ).catch(() => undefined);
  if (!scope.product) throw new SignInRefusal(signInRefusalMessage(scope, new URL(productionUrl).hostname));
  await writeFile(AUTH_CANDIDATE_READY_PATH, `${new Date().toISOString()}\n`, { mode: 0o600 });
}
