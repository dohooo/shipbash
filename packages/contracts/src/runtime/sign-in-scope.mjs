// The one ruler for "did the takeover sign into the product": the container
// that seals a capture and the host that judges it before saving both read
// the same agent-browser state through readSignInScope, so neither can pass
// a capture the other would refuse.
//
// The page is the judge. A sign-in that finishes on the identity provider and
// never reaches the product leaves the product page on its sign-in surface
// (for example: twenty-eight google.com cookies, the product still on
// /sign-in). Nothing in the cookies themselves tells a session apart from
// what a visitor gets before signing in — analytics cookies on the
// registrable domain, httpOnly CSRF and framework session cookies, Cloudflare's
// — so no cookie flag is a verdict. What the product page shows is. The
// anonymous baseline the container reads when the viewer opens corroborates
// it: a sign-in leaves new entries behind (a session cookie the product did
// not have, a rotated httpOnly value, a token in local storage); an accepted
// capture without any is worth a warning, never a refusal.
//
// Dependencies: tldts (pure JS, for the public suffix list) and leaves of this
// package. No node built-ins: this is reachable from the console's workflow
// bundle.
import { getDomain } from "tldts";

import { originHoldsStorage, originStorageKinds, storageEntryLabels } from "./browser-state.mjs";
import { isRecord } from "./contract-values.mjs";

/** The URL's hostname, lowercased, or "" for anything that does not parse. */
export function hostOf(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The page's origin and path; a query or hash may carry a code, and is not kept. */
export function publicPageUrl(href) {
  const parsed = new URL(href);
  return `${parsed.origin}${parsed.pathname}`;
}

function originOf(value) {
  try {
    return new URL(String(value)).origin.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The site a host belongs to: its registrable domain (eTLD+1, private
 * suffixes such as vercel.app counted as suffixes), so app., api., auth., www.
 * and the apex are one site and co.uk is not. A host the suffix list cannot
 * place — localhost, an IP address — is its own site.
 *
 * @param {unknown} host A hostname or a cookie domain, leading dot allowed.
 * @returns {string} The site, lowercased, or "" for nothing.
 */
export function registrableDomain(host) {
  const bare = String(host ?? "").trim().toLowerCase().replace(/^\./u, "");
  if (bare.length === 0) return "";
  return getDomain(bare, { allowPrivateDomains: true }) ?? bare;
}

function stateLists(state) {
  return {
    cookies: isRecord(state) && Array.isArray(state.cookies) ? state.cookies : [],
    origins: isRecord(state) && Array.isArray(state.origins) ? state.origins : [],
  };
}

/** A cookie's bare domain, or "" when the entry carries none (an entry without one is invisible: it names no site). */
function cookieDomain(cookie) {
  const domain = isRecord(cookie) && typeof cookie.domain === "string" ? cookie.domain : "";
  return domain.trim().toLowerCase().replace(/^\./u, "");
}

/**
 * A stored origin's host, or "" when the origin does not parse or holds
 * nothing (an entry that names no site, or a database a page created empty
 * on load, is skipped).
 */
function originHost(origin) {
  return isRecord(origin) && typeof origin.origin === "string" && originHoldsStorage(origin) ? hostOf(origin.origin) : "";
}

/**
 * The databases on the product's site the capture could not read — over a
 * limit, out of time, refused — as `name: reason`. A sign-in may be in one
 * of them, so a refusal for holding nothing must not call it uncapturable.
 */
function unsupportedDatabases(state, productSite) {
  const entries = [];
  for (const origin of stateLists(state).origins) {
    if (!isRecord(origin) || registrableDomain(hostOf(origin.origin)) !== productSite || !Array.isArray(origin.indexedDB)) continue;
    for (const database of origin.indexedDB) {
      if (isRecord(database) && typeof database.unsupported === "string") {
        entries.push(`${typeof database.name === "string" ? database.name : ""}: ${database.unsupported}`);
      }
    }
  }
  return entries;
}

/** The container's reading of the product page at capture, or null when it had none to read. */
function pageVerdictFrom(page) {
  if (!isRecord(page) || typeof page.url !== "string" || typeof page.signInSurface !== "boolean") {
    return null;
  }
  const signals = Array.isArray(page.signals) ? page.signals.filter((entry) => typeof entry === "string") : [];
  return { url: page.url, signInSurface: page.signInSurface, signals };
}

/**
 * Sorts the state's entries into the product's site and everyone else's. An
 * origin counts for the product when it holds anything — an entry in
 * localStorage or sessionStorage, a record in IndexedDB — and productStorage
 * names which of the three the product's origins hold.
 *
 * @returns {{ productCookies: number, productOrigins: number, productStorage: string[], elsewhere: string[] }}
 */
function siteCounts(state, productSite) {
  const { cookies, origins } = stateLists(state);
  const elsewhere = new Set();
  const productStorage = new Set();
  let productCookies = 0;
  let productOrigins = 0;
  for (const cookie of cookies) {
    const domain = cookieDomain(cookie);
    if (domain.length === 0) continue;
    if (registrableDomain(domain) === productSite) productCookies += 1;
    else elsewhere.add(domain);
  }
  for (const origin of origins) {
    const host = originHost(origin);
    if (host.length === 0) continue;
    if (registrableDomain(host) !== productSite) {
      elsewhere.add(host);
      continue;
    }
    productOrigins += 1;
    for (const kind of originStorageKinds(origin)) productStorage.add(kind);
  }
  return {
    productCookies,
    productOrigins,
    productStorage: ["localStorage", "sessionStorage", "indexedDB"].filter((kind) => productStorage.has(kind)),
    elsewhere: [...elsewhere],
  };
}

/**
 * The verdict, from the page first: no product page open, or one still on
 * its sign-in surface, refuses whatever the cookies say; a product page past
 * sign-in accepts as long as the browser holds anything of the product's to
 * save.
 *
 * @returns {"accepted" | "no_product_page" | "sign_in_surface" | "no_product_storage"}
 */
function verdictReason(page, counts) {
  if (page === null) return "no_product_page";
  if (page.signInSurface) return "sign_in_surface";
  return counts.productCookies + counts.productOrigins > 0 ? "accepted" : "no_product_storage";
}

/**
 * What an agent-browser state holds, read against the product.
 *
 * @param {unknown} state The `{cookies, origins}` agent-browser state.
 * @param {unknown} productionOrigin The product URL or origin the takeover opened on.
 * @param {unknown} [page] The container's `{url, signInSurface, signals}` reading of the product page at capture.
 * @param {string[] | null} [newSignInEntries] What signInBaselineDiff found, or null when there was no baseline to diff against.
 * @param {unknown} [unanswered] The hosts of the pages the capture asked and got no usable answer from in time.
 * @returns {{
 *   productOrigin: string, productSite: string, product: boolean,
 *   reason: "accepted" | "no_product_page" | "sign_in_surface" | "no_product_storage",
 *   page: { url: string, signInSurface: boolean, signals: string[] } | null,
 *   productCookies: number, productOrigins: number, productStorage: string[], elsewhere: string[],
 *   newSignInEntries: string[] | null, unanswered: string[], warnings: string[], cookies: number, origins: number,
 * }} `elsewhere` lists the foreign hosts in first-seen order, cookies before origins.
 */
export function readSignInScope(state, productionOrigin, page = null, newSignInEntries = null, unanswered = []) {
  const productOrigin = originOf(productionOrigin);
  const productSite = registrableDomain(hostOf(productionOrigin));
  const counts = siteCounts(state, productSite);
  const verdict = pageVerdictFrom(page);
  const reason = productSite.length === 0 ? "no_product_page" : verdictReason(verdict, counts);
  const entries = Array.isArray(newSignInEntries)
    ? newSignInEntries.filter((entry) => typeof entry === "string")
    : null;
  const unansweredHosts = Array.isArray(unanswered) ? unanswered.filter((host) => typeof host === "string") : [];
  const warnings = [
    ...(reason === "accepted" && entries !== null && entries.length === 0 ? ["no_new_sign_in_entries"] : []),
    ...(unansweredHosts.length > 0 ? ["pages_unanswered"] : []),
    ...unsupportedDatabases(state, productSite).map((entry) => `indexeddb_unsupported:${entry}`),
  ];
  const { cookies, origins } = stateLists(state);
  return {
    productOrigin,
    productSite,
    product: reason === "accepted",
    reason,
    page: verdict,
    ...counts,
    newSignInEntries: entries,
    unanswered: unansweredHosts,
    warnings,
    cookies: cookies.length,
    origins: origins.length,
  };
}

/** Cookies keyed by name and bare domain, values kept for the rotation test. */
function cookieIndex(state, productSite) {
  const index = new Map();
  for (const cookie of stateLists(state).cookies) {
    const domain = cookieDomain(cookie);
    if (domain.length === 0 || registrableDomain(domain) !== productSite || typeof cookie.name !== "string") continue;
    index.set(`${cookie.name}@${domain}`, cookie);
  }
  return index;
}

/** Stored entry labels (storage, session, indexeddb — names, never values) keyed by origin, for the product's site only. */
function storageIndex(state, productSite) {
  const index = new Map();
  for (const origin of stateLists(state).origins) {
    const host = originHost(origin);
    if (host.length === 0 || registrableDomain(host) !== productSite) continue;
    index.set(originOf(origin.origin), new Set(storageEntryLabels(origin)));
  }
  return index;
}

/**
 * What a sign-in left behind on the product's site since the anonymous
 * baseline: a cookie by a name the product did not have, an httpOnly cookie
 * whose value changed (a server that rotates its session on sign-in), or a
 * stored entry by a new name — in localStorage, sessionStorage or an
 * IndexedDB record. Analytics, CSRF and bot-management cookies are all in
 * the baseline already, so they never show up here.
 *
 * @param {unknown} before The state read when the viewer opened, before anyone signed in.
 * @param {unknown} after The state read when the viewer closed.
 * @param {unknown} productionOrigin The product URL or origin.
 * @returns {string[]} Entries such as `cookie session@app.example.com`,
 *   `cookie _app_session@example.com (rotated)`, `storage sb-auth-token@https://app.example.com`,
 *   `session msal.token.keys@https://app.example.com`,
 *   `indexeddb firebaseLocalStorageDb/firebaseLocalStorage/firebase:authUser:…@https://app.example.com`.
 */
export function signInBaselineDiff(before, after, productionOrigin) {
  const productSite = registrableDomain(hostOf(productionOrigin));
  const entries = [];
  const baseline = cookieIndex(before, productSite);
  for (const [key, cookie] of cookieIndex(after, productSite)) {
    const earlier = baseline.get(key);
    if (!earlier) entries.push(`cookie ${key}`);
    else if (cookie.httpOnly === true && earlier.value !== cookie.value) entries.push(`cookie ${key} (rotated)`);
  }
  const storedBefore = storageIndex(before, productSite);
  for (const [origin, names] of storageIndex(after, productSite)) {
    const earlier = storedBefore.get(origin) ?? new Set();
    for (const label of names) if (!earlier.has(label)) entries.push(`${label}@${origin}`);
  }
  return entries;
}

/** True when a page of the product's site was asked and gave no usable answer in time: a page like that is not a closed one. */
function productPageUnanswered(scope) {
  return scope.unanswered.some((host) => registrableDomain(host) === scope.productSite);
}

/** The product's site entries as one keyed set: `cookie name@domain`, and each stored entry's label (`storage`, `session`, `indexeddb`) at its origin. */
function productEntryKeys(state, productSite) {
  const keys = new Set();
  for (const key of cookieIndex(state, productSite).keys()) keys.add(`cookie ${key}`);
  for (const [origin, names] of storageIndex(state, productSite)) {
    for (const label of names) keys.add(`${label}@${origin}`);
  }
  return keys;
}

/** How many cookies and stored origins the state holds on the product's own site. */
export function productStateEntryCount(state, productionOrigin) {
  const productSite = registrableDomain(hostOf(productionOrigin));
  const { productCookies, productOrigins } = siteCounts(state, productSite);
  return { cookies: productCookies, origins: productOrigins };
}

/**
 * Whether saving `after` over `before` would lose a signed-in session, so the
 * caller keeps the old state instead. A leg that quietly logged out shows two
 * marks at once: its product-site entry set is a strict subset of what it
 * loaded (it only removed), and what went is where a session lives — an
 * httpOnly cookie the old state carried (the server session, not analytics),
 * or any stored entry on the product's origins — localStorage, sessionStorage
 * or an IndexedDB record (a Supabase token, an MSAL cache, a Firebase user;
 * products whose only cookie is analytics). A leg that merely rotated
 * or added entries is a superset or an equal set and never trips this.
 *
 * @param {unknown} before The state the leg loaded.
 * @param {unknown} after The state the leg is about to save.
 * @param {unknown} productionOrigin The product URL or origin.
 * @returns {"session_cookies_dropped" | "sign_in_storage_dropped" | null} A reason code when saving would be a regression, else null.
 */
export function signInStateRegression(before, after, productionOrigin) {
  const productSite = registrableDomain(hostOf(productionOrigin));
  if (productSite.length === 0) return null;
  const beforeKeys = productEntryKeys(before, productSite);
  const afterKeys = productEntryKeys(after, productSite);
  const afterIsStrictSubset =
    afterKeys.size < beforeKeys.size && [...afterKeys].every((key) => beforeKeys.has(key));
  if (!afterIsStrictSubset) return null;
  const afterCookies = cookieIndex(after, productSite);
  for (const [key, cookie] of cookieIndex(before, productSite)) {
    if (cookie.httpOnly === true && !afterCookies.has(key)) return "session_cookies_dropped";
  }
  for (const key of beforeKeys) {
    if (!key.startsWith("cookie ") && !afterKeys.has(key)) return "sign_in_storage_dropped";
  }
  return null;
}

/**
 * Why a capture with this scope cannot be saved, phrased for the person who
 * just signed in — both the host's answer and the hosted lane's. The sites
 * the browser is signed into instead are named, the diff says whether the
 * product stored anything new, and the sentence ends with what to do. A
 * product page that did not answer in time (still loading, or navigating)
 * is said to be that, never closed and never storing nothing.
 *
 * @param {ReturnType<typeof readSignInScope>} scope The scope, product false.
 * @param {string} productHost The product's hostname.
 * @returns {string} The refusal.
 */
export function signInRefusalMessage(scope, productHost) {
  const named = scope.elsewhere.slice(0, 3).join(", ");
  const rest = scope.elsewhere.length - 3;
  const elsewhere = rest > 0 ? `${named} and ${String(rest)} more` : named;
  const signedIn = elsewhere.length > 0 ? `The private browser is signed in to ${elsewhere}, but ` : "";
  if (scope.reason === "no_product_page") {
    if (productPageUnanswered(scope)) {
      return `The product page (${productHost}) did not answer in time when you saved: it was still loading or navigating. Wait for it to finish loading, then save again.`;
    }
    return `${signedIn}${signedIn ? "" : "The private browser closed and "}no page of ${productHost} was open when you saved. Go back to the product page, finish signing in there, then save.`;
  }
  if (scope.reason === "sign_in_surface") {
    // The page, the signal, and the way forward: a signed-in page can still
    // carry one sign-in-looking signal, and the person needs to know which.
    const stored = scope.newSignInEntries !== null && scope.newSignInEntries.length > 0
      ? ` Since the browser opened it stored: ${scope.newSignInEntries.slice(0, 3).join(", ")}.`
      : "";
    return `The product page open when you saved (${scope.page?.url ?? ""}) still looks like a sign-in surface to ShipBash (${scope.page?.signals.join(", ") ?? ""}). Open the product's home or dashboard page in the browser that just opened, then save.${stored}`;
  }
  if (productPageUnanswered(scope)) {
    return `${productHost} has left its sign-in page, but the page did not answer in time when you saved (still loading or navigating), so what it stores could not be read. Wait for it to finish loading, then save again.`;
  }
  const unsupported = scope.warnings.find((warning) => warning.startsWith("indexeddb_unsupported:"));
  if (unsupported) {
    return `${productHost} has left its sign-in page, but a database on it is over ShipBash's reading limit (${unsupported.slice("indexeddb_unsupported:".length)}), and its sign-in may be in it. Signing in again will not change this. Cancel the takeover; a test account with a password is the way to run this product unattended.`;
  }
  return `${productHost} has left its sign-in page, but the browser holds nothing of the product's to keep: ${UNCAPTURABLE_SIGN_IN}`;
}

/**
 * The one refusal signing in again cannot fix: the product keeps its session
 * where the capture cannot reach. Both the ruler's message and the host's
 * "sealed nothing" answer end on it, so the person hears the same way out.
 */
export const UNCAPTURABLE_SIGN_IN =
  "this product keeps its sign-in somewhere ShipBash cannot capture (in memory only, or a storage it does not read). Signing in again will not change this. Cancel the takeover; a test account with a password is the way to run this product unattended.";
