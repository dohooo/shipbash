/**
 * Shared vocabulary for agent_action telemetry: one row per completed browser
 * tool call, reported by the pi tool wrapper (which sees every call's name,
 * args, duration and outcome in-process). Targets are structural only — a URL
 * reduced to origin+pathname, a selector, a wait condition — read from the
 * fields that say where an action lands, never from one that carries what it
 * types, and never from a tool result; the runner re-redacts every string
 * before an event leaves the container.
 */
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

// The verb vocabulary, nearest-verb mapped from the tool suffix;
// anything that only looks at the page is a "read".
const ACTION_VERBS = new Map([
  ["open", "open"],
  ["tab_new", "open"],
  ["reload", "reload"],
  ["back", "path"],
  ["forward", "path"],
  ["click", "click"],
  ["dblclick", "click"],
  ["check", "click"],
  ["uncheck", "click"],
  ["select", "click"],
  ["focus", "click"],
  ["hover", "click"],
  ["drag", "click"],
  ["upload", "click"],
  ["download", "click"],
  ["dialog_accept", "click"],
  ["dialog_dismiss", "click"],
  ["type", "type"],
  ["fill", "type"],
  ["press", "type"],
  ["keyboard", "type"],
  ["wait", "wait"],
  ["wait_for_url", "wait"],
  ["wait_for_selector", "wait"],
  ["wait_for_text", "wait"],
  ["wait_for_load", "wait"],
  ["wait_ms", "wait"],
]);
// The read family is five different looks at the page; the row says which.
const READ_TARGETS = new Map([
  ["snapshot", "snapshot"],
  ["read", "text"],
  ["screenshot", "screenshot"],
  ["get_url", "url"],
]);
const ACTION_TARGET_LIMIT = 60;

/** origin + pathname only — the query and hash are where tokens live. */
function urlTarget(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value).split(/[?#]/u)[0] ?? "";
  }
}

/** One browser tool call's safe {verb, target} (see the header's rules). */
export function agentActionSummary(name, args) {
  const suffix = String(name).replace(/^agent_browser_/u, "");
  const safeArgs = isRecord(args) ? args : {};
  // The agent's batch (browser-batch.mjs) is the calls it makes: the first
  // one's verb, each one's target in order.
  if (suffix === "batch" && Array.isArray(safeArgs.calls)) {
    const rows = safeArgs.calls.map((call) => agentActionSummary(call?.tool, call?.args));
    const target = rows.map((row) => row.target).filter(Boolean).join(" → ");
    return { verb: rows[0]?.verb ?? "read", target: target.slice(0, ACTION_TARGET_LIMIT) };
  }
  const verb = ACTION_VERBS.get(suffix) ?? "read";
  return { verb, target: actionTarget(verb, suffix, safeArgs).slice(0, ACTION_TARGET_LIMIT) };
}

/**
 * The row's target, still structural only: a URL without its query, a wait
 * condition, the kind of look for the read family, else the selector.
 */
function actionTarget(verb, suffix, safeArgs) {
  if (verb === "open") return urlTarget(typeof safeArgs.url === "string" ? safeArgs.url : "");
  if (verb === "wait") return waitTarget(suffix, safeArgs);
  const readKind = READ_TARGETS.get(suffix);
  if (readKind) return readKind;
  return typeof safeArgs.selector === "string" ? safeArgs.selector.trim() : "";
}

/** What the wait was for: a URL shape, the awaited words, or the pause. */
function waitTarget(suffix, safeArgs) {
  if (suffix === "wait_for_url") return urlTarget(typeof safeArgs.url === "string" ? safeArgs.url : "");
  if (suffix === "wait_for_text") return typeof safeArgs.text === "string" ? `“${safeArgs.text.trim()}”` : "";
  if (suffix === "wait_for_load") return typeof safeArgs.state === "string" ? safeArgs.state : "load";
  if (suffix === "wait_ms") {
    const ms = Number(safeArgs.ms);
    return Number.isFinite(ms) && ms > 0 ? (ms >= 1000 ? `${String(Math.round(ms / 100) / 10)}s` : `${String(ms)}ms`) : "";
  }
  return typeof safeArgs.selector === "string" ? safeArgs.selector.trim() : "";
}
