// Restoring a sign-in state into the harness's browser over CDP, in place of
// agent-browser's `state load`: the cookies in one Network.setCookies, then
// every origin that holds storage is navigated to, with the request answered
// by an empty document from Fetch interception so nothing reaches the
// product, and its localStorage, sessionStorage and IndexedDB are written
// there by page scripts (the IndexedDB one from
// contracts/runtime/browser-storage-script.mjs), once the document on the
// origin is ShipBash's own. `state load` visited each origin's real root,
// waited a fixed 500 ms and wrote one key per evaluate, and the product then
// loaded a second time on open; here it loads once, on open. A service
// worker the product registered is bypassed, or it would answer the
// navigation itself, past the interception. Cookies go back as `state load`
// set them (without a partition key). A state that cannot be read, or whose
// cookies the browser refuses, throws, as `state load` did; what of an
// origin's storage did not go back is named in the outcome, and the leg goes
// on — the first frame will say whether the sign-in held.
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";
import { indexedDbRestoreExpression } from "@shipbash/contracts/runtime/browser-storage-script.mjs";

import { readBrowserStateFile } from "./browser-state-seal.mjs";
import { openCdpChannel } from "./cdp-channel.mjs";

const LABEL = "Agent browser";
const EMPTY_PAGE_TITLE = "ShipBash";
const EMPTY_PAGE = Buffer.from(`<!doctype html><title>${EMPTY_PAGE_TITLE}</title>`).toString("base64");
/** The origin of the document when it is the empty page, "" for any other document. */
const OWN_DOCUMENT_EXPRESSION = `document.title === ${JSON.stringify(EMPTY_PAGE_TITLE)} ? location.origin : ""`;
const RESPONSE_HEADERS = [
  { name: "Content-Type", value: "text/html; charset=utf-8" },
  { name: "Cache-Control", value: "no-store" },
];

function hasIndexedDbRecords(origin) {
  return origin.indexedDB.some((database) =>
    database.unsupported === undefined && database.stores.some((store) => store.records.length > 0));
}

/** The origins of a state with anything to write in a document on them. */
function originsToRestore(state) {
  return state.origins.filter((origin) =>
    origin.localStorage.length > 0 || origin.sessionStorage.length > 0 || hasIndexedDbRecords(origin));
}

/** The cookies as `state load` set them: Chromium's fields, without the partition key it never passed. */
function cookieParams(cookies) {
  return cookies.map(({ name, value, domain, path, expires, httpOnly, secure, sameSite }) =>
    ({ name, value, domain, path, expires, httpOnly, secure, ...(sameSite ? { sameSite } : {}) }));
}

/** Writes both storages of the document's origin in one evaluate. */
function storageExpression(origin) {
  const areas = `[[localStorage, ${JSON.stringify(origin.localStorage)}], [sessionStorage, ${JSON.stringify(origin.sessionStorage)}]]`;
  return `(() => { for (const [area, entries] of ${areas}) for (const { name, value } of entries) area.setItem(name, value); })()`;
}

async function pageSocketUrl(baseUrl) {
  const response = await fetch(`${baseUrl}/json/list`);
  if (!response.ok) throw new Error(`The ${LABEL} CDP endpoint was unavailable.`);
  const targets = await response.json();
  const page = Array.isArray(targets)
    ? targets.find((target) => isRecord(target) && target.type === "page" && typeof target.webSocketDebuggerUrl === "string")
    : null;
  if (!page) throw new Error(`The ${LABEL} page target was unavailable.`);
  return page.webSocketDebuggerUrl;
}

/** Answers every intercepted request with the empty document: the origin is reached, the product is not. */
function fulfillWithEmptyPage(channel) {
  return (params) => {
    if (!isRecord(params) || typeof params.requestId !== "string") return;
    void channel.command("Fetch.fulfillRequest", {
      requestId: params.requestId,
      responseCode: 200,
      responseHeaders: RESPONSE_HEADERS,
      body: EMPTY_PAGE,
    }).catch(() => {});
  };
}

/**
 * Resolves once the page has loaded the empty document on `origin`: each
 * load event is checked against the document's title and location, so the
 * product page state load left the tab on — same origin, its load event
 * still to come — cannot pass for this one.
 */
function documentOn(channel, origin, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.off("Page.loadEventFired");
      reject(new Error(`The page did not load ${origin} in time.`));
    }, timeoutMs);
    channel.on("Page.loadEventFired", () => {
      void channel.command("Runtime.evaluate", { expression: OWN_DOCUMENT_EXPRESSION, returnByValue: true })
        .then((evaluated) => {
          if (evaluated?.result?.value !== origin) return;
          clearTimeout(timer);
          channel.off("Page.loadEventFired");
          resolve();
        })
        .catch(() => {});
    });
  });
}

function outcomeFrom(evaluated) {
  if (isRecord(evaluated?.exceptionDetails)) {
    throw new Error(String(evaluated.exceptionDetails.text ?? "The restore script threw."));
  }
  const value = evaluated?.result?.value;
  const parsed = typeof value === "string" ? JSON.parse(value) : null;
  if (!isRecord(parsed) || !Array.isArray(parsed.restored) || !Array.isArray(parsed.failed)) {
    throw new Error("The page did not answer the restore.");
  }
  return { restored: parsed.restored.map(String), failed: parsed.failed.map(String) };
}

/** The storages' write on the origin's document: nothing, or the failure it threw. */
async function writeStorage(channel, origin) {
  if (origin.localStorage.length === 0 && origin.sessionStorage.length === 0) return [];
  const written = await channel.command("Runtime.evaluate", { expression: storageExpression(origin), returnByValue: true });
  return isRecord(written?.exceptionDetails) ? [`storage: ${String(written.exceptionDetails.text ?? "the write threw")}`] : [];
}

/** One origin: intercept, navigate to its empty document, write its storages and databases there. */
async function restoreOrigin(channel, origin, timeoutMs) {
  await channel.command("Fetch.enable", { patterns: [{ urlPattern: `${origin.origin}/*`, requestStage: "Request" }] });
  try {
    const loaded = documentOn(channel, origin.origin, timeoutMs);
    loaded.catch(() => {});
    await channel.command("Page.navigate", { url: `${origin.origin}/` });
    await loaded;
    const failed = await writeStorage(channel, origin);
    if (!hasIndexedDbRecords(origin)) return { restored: [], failed };
    const evaluated = await channel.command(
      "Runtime.evaluate",
      { expression: indexedDbRestoreExpression(origin.indexedDB), awaitPromise: true, returnByValue: true },
      { timeoutMs },
    );
    const databases = outcomeFrom(evaluated);
    return { restored: databases.restored, failed: [...failed, ...databases.failed] };
  } finally {
    await channel.command("Fetch.disable").catch(() => {});
  }
}

/**
 * Puts a sign-in state back into the browser behind the CDP endpoint: its
 * cookies, then each origin's storages and databases, one origin after
 * another on its first page, and leaves that page blank for the product to
 * open on.
 *
 * @param {string} baseUrl `http://host:port` of the CDP endpoint.
 * @param {import("@shipbash/contracts/runtime/browser-state.mjs").BrowserState} state
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ origins: number, restored: string[], failed: string[] }>}
 *   `origins` counts those with IndexedDB records, `restored` names each
 *   database as `name@origin`, and `failed` names what did not go back and
 *   why.
 */
export async function restoreBrowserState(baseUrl, state, options = {}) {
  const { timeoutMs = 15_000 } = options;
  const origins = originsToRestore(state);
  const outcome = { origins: origins.filter(hasIndexedDbRecords).length, restored: [], failed: [] };
  const channel = await openCdpChannel(await pageSocketUrl(baseUrl), { timeoutMs, label: LABEL });
  try {
    if (state.cookies.length > 0) await channel.command("Network.setCookies", { cookies: cookieParams(state.cookies) });
    if (origins.length === 0) return outcome;
    channel.on("Fetch.requestPaused", fulfillWithEmptyPage(channel));
    await channel.command("Page.enable");
    await channel.command("Network.setBypassServiceWorker", { bypass: true });
    for (const origin of origins) {
      try {
        const result = await restoreOrigin(channel, origin, timeoutMs);
        outcome.restored.push(...result.restored.map((name) => `${name}@${origin.origin}`));
        outcome.failed.push(...result.failed.map((entry) => `${entry}@${origin.origin}`));
      } catch (error) {
        outcome.failed.push(`${origin.origin}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await channel.command("Page.navigate", { url: "about:blank" }).catch(() => {});
  } finally {
    channel.close();
  }
  return outcome;
}

/**
 * Restores the state file at `statePath` into the browser `env` joins
 * (AGENT_BROWSER_CDP). Throws when the file cannot be read or the browser
 * refuses its cookies; answers the outcome when an origin carried IndexedDB
 * records or something did not go back, and null otherwise.
 *
 * @param {{ env: Record<string, string | undefined>, statePath: string, timeoutMs?: number }} input
 */
export async function restoreStateFile({ env, statePath, timeoutMs }) {
  if (!env.AGENT_BROWSER_CDP) throw new Error(`The ${LABEL} CDP endpoint is unknown (AGENT_BROWSER_CDP).`);
  const state = await readBrowserStateFile(statePath, env.AGENT_BROWSER_ENCRYPTION_KEY);
  const outcome = await restoreBrowserState(`http://${new URL(env.AGENT_BROWSER_CDP).host}`, state, { timeoutMs });
  return outcome.origins > 0 || outcome.failed.length > 0 ? outcome : null;
}

/** The outcome as an event carries it: counts and the first failure, never a value. */
export function indexedDbRestoreSummary(outcome) {
  return {
    indexedDbOrigins: outcome.origins,
    indexedDbRestored: outcome.restored.length,
    indexedDbFailed: outcome.failed.length,
    indexedDbFailure: outcome.failed[0] ?? null,
  };
}
