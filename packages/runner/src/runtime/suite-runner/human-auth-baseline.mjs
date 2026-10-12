// The anonymous baseline: what the viewer held before anyone signed in,
// read once the product page has loaded. The capture diffs the signed-in
// state against it (contracts/runtime/sign-in-scope.mjs) so a sign-in shows
// as the entries it left behind — a session cookie by a new name, a rotated
// httpOnly value, a token in local storage — while the analytics, CSRF and
// bot-management cookies a visitor gets before signing in are already here
// and never count. Corroboration and diagnosis only: the page is the judge.
import { setTimeout as delay } from "node:timers/promises";

import { hostOf, registrableDomain } from "@shipbash/contracts/runtime/sign-in-scope.mjs";

import { humanAuthStateFromCdp } from "./human-auth-cdp.mjs";

const DEFAULTS = Object.freeze({ pollMs: 500, settleMs: 1_500, timeoutMs: 15_000, awaitMs: 2_000 });
let pending = null;

/** True once a page of the product's site has finished loading. */
function productPageLoaded(pages, productSite) {
  return pages.some((page) =>
    page !== null && registrableDomain(hostOf(page.href)) === productSite && page.readyState === "complete");
}

async function readBaseline(productionUrl, options) {
  const productSite = registrableDomain(hostOf(productionUrl));
  const deadline = Date.now() + options.timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const reading = await humanAuthStateFromCdp().catch(() => null);
    if (reading) last = reading;
    if (reading && productPageLoaded(reading.pages, productSite)) {
      // Analytics scripts set their cookies a beat after the document is
      // complete; a baseline read before them would count them as new.
      await delay(options.settleMs);
      const settled = await humanAuthStateFromCdp().catch(() => null);
      return { state: (settled ?? reading).state, capturedAt: new Date().toISOString(), loaded: true };
    }
    await delay(options.pollMs);
  }
  return last ? { state: last.state, capturedAt: new Date().toISOString(), loaded: false } : null;
}

/**
 * Begins reading the baseline; never throws and never blocks the viewer
 * coming up.
 *
 * @param {string} productionUrl The URL the viewer opened on.
 * @param {{ pollMs?: number, settleMs?: number, timeoutMs?: number, awaitMs?: number }} [options]
 */
export function startAnonymousBaseline(productionUrl, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  pending = { settings, promise: readBaseline(productionUrl, settings).catch(() => null) };
}

/**
 * The baseline, or null when none was started, none could be read, or the
 * read is still going — teardown is not held for it.
 *
 * @returns {Promise<{ state: unknown, capturedAt: string, loaded: boolean } | null>}
 */
export async function settledBaseline() {
  if (!pending) return null;
  return Promise.race([pending.promise, delay(pending.settings.awaitMs).then(() => null)]);
}

/** What the scope file records of the baseline: when, and how much — never a value. */
export function baselineSummary(baseline) {
  if (!baseline) return null;
  const state = baseline.state;
  return {
    capturedAt: baseline.capturedAt,
    loaded: baseline.loaded,
    cookies: Array.isArray(state?.cookies) ? state.cookies.length : 0,
    origins: Array.isArray(state?.origins) ? state.origins.length : 0,
  };
}
