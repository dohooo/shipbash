// The CDP side of the ShipBash browser state capture, shared by the takeover
// viewer (a Chromium of its own on the human-auth CDP port) and the
// Activity's agent browser (reached through `agent-browser get cdp-url`):
// the browser-wide socket answers for cookies, then each page is asked for
// its storage over its own socket with the page script from
// contracts/runtime/browser-storage-script.mjs. Pure of any file I/O.
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";
import { normalizeBrowserState, originHoldsStorage } from "@shipbash/contracts/runtime/browser-state.mjs";
import { BROWSER_STORAGE_BUDGET, browserStoragePageExpression } from "@shipbash/contracts/runtime/browser-storage-script.mjs";
import { hostOf } from "@shipbash/contracts/runtime/sign-in-scope.mjs";

/**
 * One CDP command over a socket of its own: connect, send, take the answer,
 * close. `label` names the browser in the error a caller reports.
 *
 * @param {string} webSocketUrl The browser-wide or page socket.
 * @param {string} method The CDP method.
 * @param {Record<string, unknown>} [params]
 * @param {{ timeoutMs?: number, label?: string }} [options]
 */
export function cdpCommand(webSocketUrl, method, params = {}, options = {}) {
  const { timeoutMs = 10_000, label = "browser" } = options;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => {
      finish(new Error(`The ${label} CDP command ${method} timed out.`));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id !== 1) return;
      if (message.error) {
        finish(new Error(`The ${label} CDP command ${method} failed.`));
      } else {
        finish(null, message.result ?? {});
      }
    });
    socket.addEventListener("error", () => {
      finish(new Error(`The ${label} CDP command ${method} could not connect.`));
    });
    socket.addEventListener("close", () => {
      if (!settled) finish(new Error(`The ${label} CDP command ${method} disconnected.`));
    });
  });
}

/**
 * The payload of an agent-browser CLI reply, whichever envelope the calling
 * lane gets it in: the suite lane's `{ json }` wrapper, the activity lane's
 * unwrapped reply, and either one's `data` or `result.data` nesting. Every
 * reader of a reply peels it here so no second copy of the peeling exists.
 *
 * @param {unknown} reply The parsed reply, unwrapped or as `{ json }`.
 * @returns {unknown} The innermost payload, or the reply itself when it has
 *   none of the known nestings.
 */
function agentBrowserReplyData(reply) {
  const outer = isRecord(reply) && isRecord(reply.json) ? reply.json : reply;
  if (!isRecord(outer)) return outer;
  if (isRecord(outer.data)) return outer.data;
  return isRecord(outer.result) && isRecord(outer.result.data) ? outer.result.data : outer;
}

/**
 * The HTTP base of the CDP endpoint agent-browser's `get cdp-url` answered
 * with, in either reply envelope: where `/json/version` and `/json/list`
 * are served.
 *
 * @param {unknown} reply The parsed reply, unwrapped or as `{ json }`.
 * @returns {string} `http://host:port`.
 */
export function cdpBaseUrl(reply) {
  const data = agentBrowserReplyData(reply);
  const cdpUrl = isRecord(data) ? data.cdpUrl : null;
  if (typeof cdpUrl !== "string" || !cdpUrl.startsWith("ws://")) {
    throw new Error("agent-browser did not return a usable CDP URL.");
  }
  return `http://${new URL(cdpUrl).host}`;
}

/**
 * The browser-wide CDP socket plus the raw target list, or a throw naming
 * which half of the endpoint was unusable.
 *
 * @param {string} baseUrl `http://host:port` of the CDP endpoint.
 * @param {string} [label] The browser's name in an error.
 * @returns {Promise<{browserSocketUrl: string, targets: unknown}>} The socket
 *   cookies are read over, and whatever `/json/list` answered with.
 */
export async function cdpEndpoints(baseUrl, label = "browser") {
  const [versionResponse, targetsResponse] = await Promise.all([
    fetch(`${baseUrl}/json/version`),
    fetch(`${baseUrl}/json/list`),
  ]);
  if (!versionResponse.ok || !targetsResponse.ok) {
    throw new Error(`The ${label} CDP endpoint was unavailable.`);
  }
  const version = await versionResponse.json();
  const targets = await targetsResponse.json();
  if (!isRecord(version) || typeof version.webSocketDebuggerUrl !== "string") {
    throw new Error(`The ${label} browser CDP endpoint was invalid.`);
  }
  return { browserSocketUrl: version.webSocketDebuggerUrl, targets };
}

/**
 * True for a target that is an http(s) page reachable over its own socket —
 * the only kind that can be asked what it holds.
 *
 * @param {unknown} target One entry of the CDP `/json/list` answer.
 */
function storageReadableTarget(target) {
  return isRecord(target)
    && target.type === "page"
    && typeof target.url === "string"
    && /^https?:\/\//u.test(target.url)
    && typeof target.webSocketDebuggerUrl === "string";
}

/**
 * The page's answer parsed, or null when it came back as something unusable
 * — it navigated mid-capture and the evaluation is a fragment that no longer
 * parses.
 *
 * @param {unknown} value The `result.value` a Runtime.evaluate answered with.
 */
function pageAnswerFrom(value) {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Every readable page asked in target order, with the storage script and
 * `pageFields` in one evaluate. The page has `pageTimeoutMs` for its own
 * reading and a little longer to answer; one that gives no usable answer in
 * that time (still loading, navigating, its main thread busy) is skipped —
 * it can neither vouch nor be restored — and named in `unanswered`, so the
 * ruler tells a page that did not answer from one that was not open.
 *
 * @returns {Promise<{ answers: unknown[], unanswered: string[] }>} One parsed
 *   answer per page asked, null where it could not be used, and the hosts
 *   of the pages that gave none.
 */
async function pageAnswers(targets, { label, pageFields, pageTimeoutMs }) {
  const expression = browserStoragePageExpression(pageFields, { timeoutMs: pageTimeoutMs });
  const answers = [];
  const unanswered = [];
  if (!Array.isArray(targets)) return { answers, unanswered };
  for (const target of targets) {
    if (!storageReadableTarget(target)) continue;
    const evaluated = await cdpCommand(
      target.webSocketDebuggerUrl,
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      { label, timeoutMs: pageTimeoutMs + Math.min(pageTimeoutMs, 2_000) },
    ).catch(() => null);
    const answer = pageAnswerFrom(evaluated?.result?.value);
    if (answer === null) unanswered.push(hostOf(target.url));
    answers.push(answer);
  }
  return { answers, unanswered };
}

/**
 * The answers keyed by origin, so a second page on an origin already seen
 * updates that origin's reading in place rather than appending a duplicate;
 * a page that holds nothing leaves an earlier reading alone.
 */
function originsFrom(answers) {
  const origins = new Map();
  for (const answer of answers) {
    if (!isRecord(answer) || typeof answer.origin !== "string" || !originHoldsStorage(answer)) continue;
    origins.set(answer.origin, answer);
  }
  return [...origins.values()];
}

/**
 * The browser's state as the ShipBash document: every cookie Chromium
 * reports, every field kept, and each origin's localStorage, sessionStorage
 * and IndexedDB as its pages answered.
 *
 * @param {string} baseUrl `http://host:port` of the CDP endpoint.
 * @param {{ label?: string, pageFields?: string, pageTimeoutMs?: number }} [options]
 *   `pageFields` is an object-literal fragment evaluated beside the storage
 *   (the takeover's page reading); `pageTimeoutMs` is each page's budget.
 * @returns {Promise<{
 *   state: import("@shipbash/contracts/runtime/browser-state.mjs").BrowserState,
 *   answers: unknown[],
 *   unanswered: string[],
 * }>} The state, each page's parsed answer, and the hosts of the pages that gave none in time.
 */
export async function captureBrowserState(baseUrl, options = {}) {
  const { label = "browser", pageFields = "", pageTimeoutMs = BROWSER_STORAGE_BUDGET.timeoutMs } = options;
  const { browserSocketUrl, targets } = await cdpEndpoints(baseUrl, label);
  const cookieResult = await cdpCommand(browserSocketUrl, "Storage.getCookies", {}, { label });
  const { answers, unanswered } = await pageAnswers(targets, { label, pageFields, pageTimeoutMs });
  return {
    state: normalizeBrowserState({ cookies: cookieResult?.cookies, origins: originsFrom(answers) }),
    answers,
    unanswered,
  };
}
