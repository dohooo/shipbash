/**
 * Tab labels the daemon accepts (agent-browser v0.33.1, is_valid_label): an
 * ASCII letter first, then ASCII letters, digits, `-`, and `_`. The agent's
 * first instinct is a phrase — "Example device sign-in" — which the daemon
 * refuses, costing a round. The proxy rewrites
 * the label deterministically instead, and applies the same rewrite to a tab
 * reference in tab_switch / tab_close, so the phrase the agent remembers still
 * resolves to the tab it opened. Ids (t2) and target ids never contain the
 * characters that trigger a rewrite, so they pass untouched.
 */
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

const LABEL_FIELDS = new Map([
  ["agent_browser_tab_new", "label"],
  ["agent_browser_tab_switch", "tab"],
  ["agent_browser_tab_close", "tab"],
]);
const INVALID_RUN = /[^A-Za-z0-9_-]+/gu;
const INVALID_CHAR = /[^A-Za-z0-9_-]/u;

/** The daemon-valid label nearest to a phrase: runs of other characters become `_`, a non-letter start gets `t_`. */
export function normalizeTabLabel(value) {
  const label = value.trim().replace(INVALID_RUN, "_");
  if (!label) return "";
  return /^[A-Za-z]/u.test(label) ? label : `t_${label}`;
}

/**
 * Rewrites the one tab-label argument of a forwarded call in place and
 * returns what changed ({ field, from, to }; `to` is null when an empty label
 * was dropped so the daemon names the tab itself), or null when the call was
 * left as sent. A tab reference is rewritten only when it carries characters
 * no id could — a clean value that merely starts with a digit may be a target id.
 */
export function rewriteTabLabelArguments(request) {
  if (request?.method !== "tools/call" || !isRecord(request.params) || !isRecord(request.params.arguments)) {
    return null;
  }
  const field = LABEL_FIELDS.get(request.params.name);
  const args = request.params.arguments;
  if (!field || typeof args[field] !== "string") return null;
  const from = args[field];
  if (field === "label" && !from.trim()) {
    delete args.label;
    return { field, from, to: null };
  }
  const to = normalizeTabLabel(from);
  const unchanged = field === "label" ? to === from : !INVALID_CHAR.test(from);
  if (unchanged || !to) return null;
  args[field] = to;
  return { field, from, to };
}

/** The note a rewritten call carries back: what changed, and the name to use from now on. */
export function tabLabelNote({ field, from, to }) {
  if (to === null) return "[ShipBash harness] Dropped the empty tab label; the daemon named the tab itself.";
  const what = field === "label" ? "the tab label" : "the tab reference";
  return `[ShipBash harness] Rewrote ${what} "${from}" as "${to}": tab labels start with a letter and use only `
    + `letters, digits, "-" and "_". Use "${to}" (or the tab id) to refer to this tab.`;
}
