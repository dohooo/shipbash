/**
 * The wait family's budget: how long a browser tool call was ALLOWED to take
 * because the agent asked it to wait. The proxy's slow-call note counts only
 * the time a call ran beyond this budget — a wait spending its own budget is
 * never congestion (a Discovery got a false "congested" note on a
 * wait_for_text it had asked to run 15s).
 */
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

// The wait family: a call whose duration is the agent's own budget. The slow
// note only counts what a call ran BEYOND that budget.
const WAIT_TOOLS = new Set([
  "agent_browser_wait_ms",
  "agent_browser_wait_for_selector",
  "agent_browser_wait_for_text",
  "agent_browser_wait_for_url",
  "agent_browser_wait_for_load",
  "agent_browser_wait_for_function",
  "agent_browser_wait_for_download",
]);
// The daemon's own ceiling for a wait condition when the call names none
// (agent-browser 0.33.1, measured: "Wait timed out after 25000ms").
const DEFAULT_WAIT_BUDGET_MS = 25_000;

function positiveMs(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The wait the agent itself asked for, in ms — the part of a call's duration
 * that can never be congestion. Zero for every tool outside the wait family.
 */
export function requestedWaitBudgetMs(name, callArgs) {
  const args = isRecord(callArgs) ? callArgs : {};
  if (!WAIT_TOOLS.has(name)) return 0;
  // A fixed wait names its whole budget; `ms: 0` asked for nothing.
  if (name === "agent_browser_wait_ms") return positiveMs(args.ms) ?? 0;
  return positiveMs(args.waitTimeoutMs) ?? DEFAULT_WAIT_BUDGET_MS;
}
