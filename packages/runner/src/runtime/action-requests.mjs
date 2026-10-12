/**
 * What the page is still waiting on since the agent's last action: the
 * requests sent since then — the action's own, and those the page sent after
 * it — and which of them have no answer yet. The browser proxy hands this to
 * whoever acts, the pi agents and Jev's executor alike, as a fact on every
 * look at the page, never as a wait of its own.
 *
 * A request can take over a second while its dialog stays unchanged, so the
 * settled page is still the dialog. Jev would judge the checkpoint "not yet",
 * not be offered it again on the unchanged page, and hand off. A person in that spot knows
 * the request they just sent is still going and looks again when it lands.
 * Established harnesses scope the same way — Playwright MCP waits for the
 * requests an action's window started, Stagehand for those in flight since
 * the call — but as a code wait on every action, which on a product that
 * keeps a long-poll open runs to its cap each time. Here the actor is told.
 *
 * A page the product opens on its own after an action (for example a
 * dashboard after a delete confirmation) goes on loading its content after the
 * action's own request has its answer. The
 * requests counted are every one sent since the action, not only those out
 * when its page settled. That list returned to also loads what it loaded
 * before, so "sent before" no longer tells the page's own traffic apart: a
 * connection it keeps open is left out, and a request it sent often in the
 * seconds before the action says so.
 *
 * The source is agent-browser's request log (`network requests`): one entry
 * per hop, with no status until the response arrives. A redirect adds a hop
 * under the same id, so a request's latest hop is its state. The daemon
 * stamps a hop when it drains the event, at the start of its next command,
 * not when the page sent it: a heartbeat the page sent while the agent was
 * thinking carries the stamp of the agent's next action. So the proxy reads
 * the log just before it sends an action, and the action's requests are the
 * ones that log did not hold.
 */

export const REQUEST_LOG_TOOL = "agent_browser_network_requests";
// What the page does on the user's behalf: API calls and page loads. Images,
// fonts, scripts and beacons are the page's own business.
export const REQUEST_LOG_ARGS = { type: "xhr,fetch,document" };
/** The line that opens the note; the executor splits a page reading on it. */
export const WAITING_NOTE = "[ShipBash harness] Requests sent since your last action that have no answer yet:";
const SHOWN = 6;

/**
 * @typedef {{ requestId: string, method: string, url: string, timestamp: number, resourceType?: string, status?: number | null }} Hop
 * @typedef {{ id: string, method: string, route: string, sentAt: number, recentBefore: number }} Started
 */

function isHop(value) {
  return typeof value === "object" && value !== null
    && typeof value.requestId === "string" && typeof value.url === "string"
    && typeof value.method === "string" && Number.isFinite(value.timestamp);
}

/** The request log a `network requests` tools/call answered with, or null when it carries none. @returns {Hop[] | null} */
export function requestLog(response) {
  const requests = response?.result?.structuredContent?.response?.data?.requests;
  return response?.result?.isError !== true && Array.isArray(requests) ? requests.filter(isHop) : null;
}

/** Host and path, without the query a token may ride in; the host only when it is not the page's. */
function routeOf(url, origin) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin === origin ? "" : parsed.host}${parsed.pathname}`;
  } catch {
    return url.split("?")[0].slice(0, 200);
  }
}

// How far back a request counts as one the page keeps sending on its own, and
// how often it must have been sent in that time to count.
const RECENT_MS = 10_000;
const RECENT_SENDS = 3;

/**
 * The requests in `log` that `before` did not hold — the log read just
 * before the action was sent, at `at` — each with how many of the same method
 * and route the page sent in the seconds before (a poll, a heartbeat). A
 * connection the page keeps open is left out: one whose route already had a
 * request waiting before the action (a long-poll renewing itself, or opened
 * again by the next page) is the page's standing traffic, not work the action
 * or its aftermath started. Told of it, Jev judged such pages busy in 18 of
 * 82 readings and spent a wait on each (measured).
 * Only the page the browser was on counts, the one its latest document load
 * opened: the log never answers a request cut off by leaving a page, so a
 * list's load cut short on an earlier visit would otherwise hide the next
 * one (measured).
 * @param {Hop[]} log
 * @param {{ hops: Hop[], at: number }} before
 * @param {string} origin the page's origin, for naming routes
 * @returns {Started[]}
 */
export function startedAfter(log, before, origin) {
  const key = (hop) => `${hop.method} ${routeOf(hop.url, origin)}`;
  const known = new Set(before.hops.map((hop) => hop.requestId));
  const pageStart = before.hops.findLastIndex((hop) => hop.resourceType === "Document");
  const latestBefore = new Map(before.hops.map((hop, index) => [hop.requestId, { hop, index }]));
  const recent = new Map();
  const standing = new Set();
  for (const hop of before.hops) {
    if (hop.timestamp >= before.at - RECENT_MS) recent.set(key(hop), (recent.get(key(hop)) ?? 0) + 1);
  }
  for (const { hop, index } of latestBefore.values()) {
    if (index > pageStart && (hop.status === undefined || hop.status === null)) standing.add(key(hop));
  }
  const first = new Map();
  for (const hop of log) {
    if (!known.has(hop.requestId) && !first.has(hop.requestId) && !standing.has(key(hop))) first.set(hop.requestId, hop);
  }
  return [...first.values()].map((hop) => ({
    id: hop.requestId,
    method: hop.method,
    route: routeOf(hop.url, origin),
    sentAt: hop.timestamp,
    recentBefore: recent.get(key(hop)) ?? 0,
  }));
}

/**
 * Those of `started` whose latest hop in `log` has had no answer; one the log
 * no longer holds is not reported.
 * @param {Hop[]} log
 * @param {Started[]} started
 * @returns {Started[]}
 */
export function unanswered(log, started) {
  const latest = new Map(log.map((hop) => [hop.requestId, hop]));
  return started.filter((request) => {
    const hop = latest.get(request.id);
    return hop !== undefined && (hop.status === undefined || hop.status === null);
  });
}

/** One line per waiting request, oldest first: what, how long ago, and how often the page sent it just before. */
function waitingLines(waiting, now) {
  const lines = waiting.slice(0, SHOWN).map((request) => {
    const seconds = Math.max(0, (now - request.sentAt) / 1_000).toFixed(1);
    const habit =
      request.recentBefore >= RECENT_SENDS
        ? `; the page sent it ${String(request.recentBefore)} times in the ${String(RECENT_MS / 1_000)} s before your action`
        : "";
    return `${request.method} ${request.route}, sent ${seconds} s ago${habit}`;
  });
  if (waiting.length > SHOWN) lines.push(`and ${String(waiting.length - SHOWN)} more`);
  return lines;
}

/** The note a result carries, or null when nothing the action started is waiting. */
export function waitingNote(waiting, now) {
  return waiting.length ? [WAITING_NOTE, ...waitingLines(waiting, now)].join("\n") : null;
}

/** A page reading split from the note riding on it: the snapshot, and the waiting requests' lines. */
export function splitWaiting(text) {
  const at = text.indexOf(`\n${WAITING_NOTE}\n`);
  if (at < 0) return { page: text, waiting: [] };
  return {
    page: text.slice(0, at),
    waiting: text.slice(at + WAITING_NOTE.length + 2).split("\n").filter(Boolean),
  };
}
