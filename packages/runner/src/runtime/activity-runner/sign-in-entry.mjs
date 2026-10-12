// Where the first frame is taken: with a saved
// sign-in applied, the browser opens on the page that sign-in was captured
// on — the signed-in entry — not on the bare production URL. Opened there,
// a leg can land on the marketing root, open /login (a form the
// product renders over a valid session), and close as "unauthenticated"
// without ever opening /app, while the product's server log shows every
// request signed in. The rule "reach the signed-in entry before you judge"
// already rode the brief and the frame; opening there makes it mechanical.
//
// The page comes from the scope the container sealed the state by
// (sign-in-scope.mjs: `page.url`, on the product's site and past its sign-in
// surface, or the capture was refused). It is kept to the production origin:
// trusted-access navigation and the entry check are both bound to it. A
// state that records no page — an older capture, a foreign origin, a refused
// scope — opens at the production URL as it always did.
import { readFileSync } from "node:fs";

import { AUTH_CANDIDATE_SCOPE_PATH, AUTH_STATE_SCOPE_PATH } from "./environment.mjs";

/**
 * The captured page a scope names, as origin + path (a query may hold a
 * token), or null when the scope holds no accepted page on this origin.
 * @param {unknown} scope The parsed `candidate.scope.json` / `state.scope.json`.
 * @param {string} productionUrl
 * @returns {string | null}
 */
export function capturedPageFrom(scope, productionUrl) {
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) return null;
  const record = /** @type {Record<string, unknown>} */ (scope);
  const page = record.page;
  if (record.product !== true || typeof page !== "object" || page === null) return null;
  const url = /** @type {Record<string, unknown>} */ (page).url;
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== new URL(productionUrl).origin) return null;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/**
 * The scope file for the state this leg loads: the candidate's after a
 * takeover, the state's otherwise; null when nothing was loaded.
 * @param {"saved_state" | "handoff_candidate" | null} signInStateSource
 */
export function loadedScopePath(signInStateSource) {
  if (signInStateSource === "handoff_candidate") return AUTH_CANDIDATE_SCOPE_PATH;
  if (signInStateSource === "saved_state") return AUTH_STATE_SCOPE_PATH;
  return null;
}

/** @param {string} path @returns {unknown} The parsed file, or null when it is absent or not JSON. */
function readScope(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The URL the leg opens first and why.
 * @param {{ productionUrl: string, signInStateSource: "saved_state" | "handoff_candidate" | null }} leg
 * @param {(path: string) => unknown} [read] The scope reader; a fake may be handed in.
 * @returns {{ url: string, source: "captured_page" | "production_url" }}
 */
export function openingEntry({ productionUrl, signInStateSource }, read = readScope) {
  const path = loadedScopePath(signInStateSource);
  const page = path === null ? null : capturedPageFrom(read(path), productionUrl);
  return page === null
    ? { url: productionUrl, source: "production_url" }
    : { url: page, source: "captured_page" };
}
