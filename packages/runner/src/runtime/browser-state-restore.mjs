// The IndexedDB half of restoring a sign-in state: agent-browser's `state
// load` puts cookies, localStorage and sessionStorage back and ignores the
// rest, so after it, and before the product opens, every origin that
// carries IndexedDB records gets them back over CDP. Each origin is
// navigated to, with the request answered by an empty document from Fetch
// interception so nothing reaches the product — a service worker the
// product registered during state load is bypassed, or it would answer the
// navigation itself, past the interception — and the page script from
// contracts/runtime/browser-storage-script.mjs rebuilds the databases
// there, once the document on the origin is ShipBash's own and not the
// product page state load left the tab on. Nothing here throws to its
// caller: what did not go back is named in the outcome, and the leg goes
// on — the first frame will say whether the sign-in held.
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";
import { indexedDbRestoreExpression } from "@shipbash/contracts/runtime/browser-storage-script.mjs";

import { cdpBaseUrl } from "./browser-state-capture.mjs";
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

/** The origins of a state that carry IndexedDB records to put back. */
export function indexedDbOrigins(state) {
  return state.origins.filter((origin) =>
    origin.indexedDB.some((database) =>
      database.unsupported === undefined && database.stores.some((store) => store.records.length > 0)));
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

/** One origin: intercept, navigate to its empty document, run the restore script there. */
async function restoreOrigin(channel, origin, timeoutMs) {
  await channel.command("Fetch.enable", { patterns: [{ urlPattern: `${origin.origin}/*`, requestStage: "Request" }] });
  try {
    const loaded = documentOn(channel, origin.origin, timeoutMs);
    loaded.catch(() => {});
    await channel.command("Page.navigate", { url: `${origin.origin}/` });
    await loaded;
    const evaluated = await channel.command(
      "Runtime.evaluate",
      { expression: indexedDbRestoreExpression(origin.indexedDB), awaitPromise: true, returnByValue: true },
      { timeoutMs },
    );
    return outcomeFrom(evaluated);
  } finally {
    await channel.command("Fetch.disable").catch(() => {});
  }
}

/**
 * Puts the IndexedDB of these origins back into the browser behind the CDP
 * endpoint, one origin after another on its first page, and leaves that
 * page blank for the product to open on.
 *
 * @param {string} baseUrl `http://host:port` of the CDP endpoint.
 * @param {import("@shipbash/contracts/runtime/browser-state.mjs").BrowserOrigin[]} origins
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ origins: number, restored: string[], failed: string[] }>}
 *   `restored` names each database as `name@origin`; `failed` names what did
 *   not go back and why.
 */
export async function restoreIndexedDb(baseUrl, origins, options = {}) {
  const { timeoutMs = 15_000 } = options;
  const outcome = { origins: origins.length, restored: [], failed: [] };
  if (origins.length === 0) return outcome;
  const channel = await openCdpChannel(await pageSocketUrl(baseUrl), { timeoutMs, label: LABEL });
  try {
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
 * The restore for a state file agent-browser just loaded: when any origin
 * in it carries IndexedDB records, asks agent-browser for its CDP endpoint
 * and puts them back. Null when the file carries none; an outcome naming
 * the failure, never a throw, when it could not be read or reached.
 *
 * @param {{
 *   agentBrowser: Function,
 *   env: Record<string, string | undefined>,
 *   statePath: string,
 *   options?: Record<string, unknown>,
 *   unwrapJson?: boolean,
 * }} input `options` are passed to the agent-browser call; `unwrapJson` says
 *   whether that call answers with the parsed reply or `{ json }`.
 */
export async function restoreIndexedDbFromStateFile({ agentBrowser, env, statePath, options = {}, unwrapJson = false }) {
  try {
    const state = await readBrowserStateFile(statePath, env.AGENT_BROWSER_ENCRYPTION_KEY);
    const origins = indexedDbOrigins(state);
    if (origins.length === 0) return null;
    const reply = await agentBrowser(["get", "cdp-url"], env, options);
    return await restoreIndexedDb(cdpBaseUrl(unwrapJson ? reply : reply?.json), origins);
  } catch (error) {
    return { origins: 0, restored: [], failed: [error instanceof Error ? error.message : String(error)] };
  }
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
