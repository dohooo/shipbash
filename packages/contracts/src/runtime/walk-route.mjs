// A walk's route: the page actions it took, each with the page it was taken
// on, read from its step record (walk.json, runner suite-runner/walk-record.mjs).
// A later walk of the same Journey is told what its newest passing walk did on
// the page it is on (runner jev-route.mjs): how to act, never whether a
// checkpoint held.

const ACTION = /^(click|fill|select|check|uncheck) (\w+) "([^"\n]*)"(?: (.+))?$/u;
const OPEN = /^open (\S+)$/u;
// A call that named its target by a selector instead of a snapshot ref: the verb, the selector, the value sent.
const SELECTED = /^(click|fill|select|check|uncheck) (.+?)(?: ("(?:[^"\\]|\\.)*"|\[.*\]))?$/u;
// The accessible name a selector states, and the role its tag implies; "*" is any role.
const SELECTOR_NAMES = [
  /\[aria-label=['"]([^'"]+)['"]\]/u,
  /\[placeholder=['"]([^'"]+)['"]\]/u,
  /:has-text\(['"]([^'"]+)['"]\)/u,
  /^text=['"]?([^'"]+?)['"]?$/u,
  /normalize-space\(\)\s*=\s*['"]([^'"]+)['"]/u,
];
const TAG_ROLES = { a: "link", button: "button", input: "textbox", textarea: "textbox", select: "combobox" };
// A path segment naming one record — a UUID, a number, a long hex id — stands for any record of its kind.
const RECORD_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[0-9a-f]{16,})$/iu;
const ROUTE_LIMIT = 40;

/** The page a URL is on, with record ids made generic, or null when it is no URL. */
export function routePath(url) {
  try {
    return new URL(url).pathname.split("/").map((segment) => (RECORD_SEGMENT.test(segment) ? ":id" : segment)).join("/");
  } catch {
    return null;
  }
}

/** The value a fill or select sent, from its recorded words; null when none was kept or it was redacted. */
function sentValue(verb, text) {
  if (text === undefined) return null;
  try {
    const value = JSON.parse(text);
    const sent = verb === "fill" ? value : Array.isArray(value) ? value[0] : null;
    return typeof sent === "string" && !sent.includes("[REDACTED]") ? sent : null;
  } catch {
    return null;
  }
}

/** The URL a text names, or null. */
function urlOf(text) {
  try {
    return text ? new URL(text) : null;
  } catch {
    return null;
  }
}

/** The title the page after a call showed: its record's first line, when that is a title. */
function titleAfter(step) {
  const title = typeof step.observation === "string" ? step.observation.split("\n", 1)[0].trim() : "";
  return title && !title.startsWith("[") && !title.startsWith("- ") ? title : "";
}

/** An open as a route action: the page it opened, by its path and the title the page showed. */
function opened(step, path) {
  const url = urlOf(OPEN.exec(step.action)?.[1]);
  return url ? { path, verb: "open", role: "page", name: titleAfter(step), value: `${url.pathname}${url.search}`, to: null } : null;
}

/** The page an action led to when it left the one it was taken on, or null. */
function ledTo(step, path) {
  const url = urlOf(step.url);
  return url && routePath(url.href) !== path ? { path: `${url.pathname}${url.search}`, title: titleAfter(step) } : null;
}

/**
 * The route a walk record took: each page action that went through, named by
 * the role and name the walk saw, with the page it was taken from (the URL the
 * record held before it), and each page it opened by URL. Withheld,
 * blacked-out and failed calls are left out, as is a fill or select whose
 * value was not kept.
 * @param {{ steps?: unknown }} record
 * @returns {import("./walk-route.d.mts").RouteAction[]}
 */
export function walkRoute(record) {
  const route = [];
  // The URLs the walk had been on, query included: /shop?q=… is a search, not a way back to /shop.
  const visited = new Set();
  let path = null;
  for (const step of Array.isArray(record.steps) ? record.steps : []) {
    if (!step || typeof step !== "object") continue;
    const action = path ? routeAction(step, path) : null;
    // An open of a URL the walk had already been on goes back, a detour a later walk need not take.
    if (action && !(action.verb === "open" && visited.has(action.value))) route.push(action);
    const url = typeof step.url === "string" ? urlOf(step.url) : null;
    if (url) visited.add(`${url.pathname}${url.search}`);
    const after = url ? routePath(url.href) : null;
    if (after) path = after;
  }
  return route.slice(0, ROUTE_LIMIT);
}

/** A selector's stated name and implied role, or null when it states no name. */
function selectorTarget(selector) {
  const name = SELECTOR_NAMES.map((pattern) => pattern.exec(selector)?.[1]).find(Boolean);
  if (!name) return null;
  const tag = /^(?:xpath=\/\/)?([a-z]+)/u.exec(selector)?.[1];
  return { role: TAG_ROLES[tag] ?? "*", name };
}

/** A recorded call's verb, target role and name, and the value it sent, by snapshot ref or by selector; null when neither names one. */
function parsedCall(action) {
  const byRef = ACTION.exec(action);
  if (byRef) return byRef.slice(1, 5);
  const bySelector = SELECTED.exec(action);
  const target = bySelector ? selectorTarget(bySelector[2]) : null;
  return target ? [bySelector[1], target.role, target.name, bySelector[3]] : null;
}

/** One recorded call as a route action taken from `path`, or null when it is no page action or did not go through. */
function routeAction(step, path) {
  if (typeof step.action !== "string" || step.failed || step.withheld || step.blackedOut) return null;
  const open = opened(step, path);
  if (open) return open;
  const parsed = parsedCall(step.action);
  if (!parsed) return null;
  const [verb, role, name, text] = parsed;
  const typed = verb === "fill" || verb === "select";
  const value = typed ? sentValue(verb, text) : null;
  return typed && value === null ? null : { path, verb, role, name, value, to: ledTo(step, path) };
}
