/**
 * The MCP proxy's argument policy: which browser a call joins, the browser's
 * state, and the raw CLI belong to the ShipBash harness, never to the agent's
 * tool calls.
 *
 * agent-browser advertises, on every tool, an `extraArgs` array ("extra CLI
 * arguments … preserving full CLI parity") and a family of restore/state
 * fields (`restore`, `restoreCheckFn`, …). Both are open doors around the
 * gates the proxy enforces: `extraArgs: ["--restore-check-fn", "<js>"]` runs
 * arbitrary page JavaScript past the eval-interaction refusal, and
 * `["--cdp", "x"]` joins a browser other than the one the harness launched,
 * streamed, and offered for takeover. `restoreCheckFn` is that JS door as a
 * first-class field, needing no extraArgs at all.
 *
 * None of these are the agent's to set (a repo-wide search finds no harness
 * use; the harness applies its own sign-in state through the CLI's `state load`
 * subcommand, never these fields), so the proxy erases them from every
 * forwarded call and every advertised schema. A stripped call carries one
 * factual note so the agent learns the field is not its own.
 */

import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";
import { rewriteTabLabelArguments, tabLabelNote } from "./agent-browser-tab-label.mjs";

/**
 * Structured arguments the harness owns, erased from every call and schema.
 * `cdp` names the browser a call joins; an explicit idle timeout ends the
 * daemon mid-walk; `allowedDomains` is the harness's network policy, which
 * agent-browser refuses over a joined browser anyway; the `restore*` family
 * replays and persists browser state the harness owns; `headed`, `webgpu` and
 * `webmcp` are launch settings of the browser the harness launched (open's,
 * in 0.38.1 mcp.rs), and webmcp is part of how a call joins it, so a call
 * that changes it makes agent-browser rejoin; `session` and `namespace` name
 * the daemon a call joins, which is the harness's browser only when the call
 * leaves them to the environment; `caCert` and `clearCaCert` are the launched
 * browser's certificate trust; `extraArgs` is raw CLI parity — any flag at
 * all, including those. agent-browser advertises session, namespace, caCert
 * and clearCaCert on every tool: they were a quarter of the tokens a case
 * agent's model turn reads (measured).
 */
export const HARNESS_OWNED_ARGUMENTS = Object.freeze([
  "cdp",
  "session",
  "namespace",
  "caCert",
  "clearCaCert",
  "headed",
  "webgpu",
  "webmcp",
  "extraArgs",
  "allowedDomains",
  "restore",
  "restoreSave",
  "restoreCheckFn",
  "restoreCheckUrl",
  "restoreCheckText",
  "idleTimeout",
]);
const HARNESS_OWNED_ARGUMENT_SET = new Set(HARNESS_OWNED_ARGUMENTS);

/**
 * Erases harness-owned arguments from a forwarded tools/call, in place, and
 * returns the argument names that were dropped (for the agent's note); an empty
 * array means the call was left untouched.
 */
export function stripHarnessOwnedArguments(request) {
  if (request.method !== "tools/call" || !isRecord(request.params) || !isRecord(request.params.arguments)) {
    return [];
  }
  const args = request.params.arguments;
  const dropped = [];
  for (const name of HARNESS_OWNED_ARGUMENTS) {
    if (name in args) {
      delete args[name];
      dropped.push(name);
    }
  }
  return dropped;
}

/** Erases the same fields from an advertised tool schema, required list included. */
export function withoutHarnessOwnedSchema(tool) {
  const properties = tool?.inputSchema?.properties;
  if (!isRecord(properties)) return tool;
  const kept = {};
  let changed = false;
  for (const [name, schema] of Object.entries(properties)) {
    if (HARNESS_OWNED_ARGUMENT_SET.has(name)) changed = true;
    else kept[name] = schema;
  }
  if (!changed) return tool;
  const inputSchema = { ...tool.inputSchema, properties: kept };
  if (Array.isArray(inputSchema.required)) {
    inputSchema.required = inputSchema.required.filter((name) => !HARNESS_OWNED_ARGUMENT_SET.has(name));
  }
  return { ...tool, inputSchema };
}

/** The one note a stripped call carries back, naming what the harness dropped. */
export function harnessOwnedNote(dropped) {
  const fields = dropped.join(", ");
  return `[ShipBash harness] Dropped ${fields}: the browser's launch, state, and raw-CLI `
    + "controls are managed by the ShipBash harness and are not part of the agent's toolset. "
    + "Continue with the tool's documented arguments.";
}

/**
 * Every change the proxy makes to a forwarded call, as note entries: the
 * harness-owned field names it erased, then the tab-label rewrite when the
 * daemon would have refused the label. Empty means the call went as sent.
 */
export function policeCallArguments(request) {
  const entries = stripHarnessOwnedArguments(request);
  const rewrite = rewriteTabLabelArguments(request);
  return rewrite ? [...entries, rewrite] : entries;
}

/** The notes a policed call carries back, one per kind of change. */
export function callArgumentNote(entries) {
  const dropped = entries.filter((entry) => typeof entry === "string");
  const notes = dropped.length > 0 ? [harnessOwnedNote(dropped)] : [];
  for (const entry of entries) {
    if (typeof entry !== "string") notes.push(tabLabelNote(entry));
  }
  return notes.join("\n");
}
