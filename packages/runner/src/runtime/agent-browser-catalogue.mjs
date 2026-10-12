/**
 * The agent's browser catalogue and the proxy's refusals: which of
 * agent-browser's tools the agent is offered, which tool calls never reach the
 * daemon — tools outside the catalogue, and arguments a tool has there but not
 * here, or needs here but not there — and the synthetic error response the
 * agent gets instead. Split from agent-browser-mcp-proxy.mjs by
 * responsibility — the proxy keeps the wire, this module keeps the policy.
 */
import { BROWSER_TOOLS } from "@shipbash/contracts/runtime/browser-catalogue.mjs";
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";
import { EVAL_INTERACTION_REFUSAL, evalInteractionAttempt } from "./reachability.mjs";

// The browser tools every agent is offered, in every lane, and why these
// (contracts browser-catalogue.mjs): every call outside them is refused here.
export const OFFERED_TOOLS = new Set(BROWSER_TOOLS);

// Why a tool outside the catalogue is refused: the reason of its own a few
// carry, else the general one (refusedTool). find and batch act inside the
// daemon — find clicks or fills whatever its locator matches, batch runs raw
// CLI commands — where the reachability gate and the cursor never see a
// target (in the runner image both filled an input under a scrim, and find
// reported a display:none button clicked). The agent's batch is the runner's,
// over the named calls (browser-batch.mjs).
const ACTIONS_OUTSIDE_THE_GATE =
  "acts inside the browser daemon, past the checks a real user's actions go through. "
  + "Take the element's ref from the snapshot and use the action tools; agent_browser_batch "
  + "in your catalogue runs several of them in one turn.";

const TOOL_REFUSALS = new Map([
  [
    "agent_browser_close",
    "agent_browser_close is disabled: the browser lifecycle is managed by the "
    + "ShipBash harness. A slow response means the browser pipeline is "
    + "congested, not dead — wait briefly or retry your previous action, and "
    + "never close or relaunch the browser.",
  ],
  ["agent_browser_find", `agent_browser_find is disabled: it ${ACTIONS_OUTSIDE_THE_GATE}`],
  ["agent_browser_batch", `agent-browser's own batch is disabled: it ${ACTIONS_OUTSIDE_THE_GATE}`],
]);

// Arguments a tool has in agent-browser but not in this harness: they leave the
// tool's schema, its description is restated without them, and a call that
// still sends one is refused, never stripped. An argument agent-browser leaves
// optional and this harness requires joins the schema's required list, and a
// call is refused the same way unless it carries that argument as a value the
// CLI reads as one: a non-empty string that does not start with "-" (see open
// below). agent_browser_read given a url, an llms view, or requireMd GETs the
// address with an HTTP client of its own (agent-browser 0.38.1 read.rs
// run_read; readTimeoutMs is that client's timeout): outside the browser, its
// tabs, and its signed-in session, with no tab moving. A walk took read with a
// url for opening the app, read the signed-out landing, then judged the stale
// tab still in front. Stripped instead of refused, the
// same call would hand back the current tab as the page that was asked for. In
// the pi lanes pi validates a call against the schema it was offered —
// agent-browser closes every tool's schema with additionalProperties: false —
// so a direct read {url} fails there before it is sent, and the description is
// what teaches it; the refusal answers the calls pi does not validate, the
// runner's agent_browser_batch items (browser-batch.mjs).
//
// agent_browser_open with a url is the daemon's navigate (0.38.1 commands.rs
// "open" | "goto" | "navigate"): the current tab loads it in the browser, as
// the address bar does. Without one it is the daemon's launch, which drops
// the harness's browser and joins it again, its state reset. The MCP server
// hands the url to the CLI as a bare argument after `open`, and the CLI reads
// a flag at any position (flags.rs parse_flags, clean_args) and takes the
// first argument not starting with "--" as the url (commands.rs:389), so a
// url of "--headed" or "-v" is no url either: in the runner image both came
// back launched, the old page handed back as the load's
// (measured). An address never starts
// with "-". open's launch settings (headed, webgpu, webmcp) are the argument
// policy's (agent-browser-arg-policy.mjs).
const OPEN_A_URL = "To load a URL, use agent_browser_open in the current tab, or agent_browser_tab_new for a tab of its own.";
// The evidence readers read their log and never clear it: the proxy reads the
// request log to tie each request to the action that sent it
// (action-requests.mjs), and the case lane's evidence recorder reads all three
// (evidence-recorder.mjs). A clear would erase what both stand on.
const NEVER_CLEARED = "The log is never cleared: read it again and compare.";
const clearRefusal = (name) => `${name} reads its log without clearing it: the ShipBash harness reads the same log `
  + "to tie each request and message to the action that caused it, and a clear would erase that record. "
  + "Call it again without clear.";
const reader = (name, description) => [name, { fields: ["clear"], description: `${description} ${NEVER_CLEARED}`, refusal: clearRefusal(name) }];
export const REFUSED_ARGUMENTS = new Map([
  reader("agent_browser_console", "Read the browser's console messages."),
  reader("agent_browser_errors", "Read the page errors the browser caught."),
  reader("agent_browser_network_requests", "List captured network requests."),
  [
    "agent_browser_read",
    {
      fields: ["url", "llms", "requireMd", "readTimeoutMs"],
      description: `Read the page in the browser's current tab as agent-readable text. It opens nothing. ${OPEN_A_URL}`,
      refusal: "agent_browser_read reads only the page in the browser's current tab: url, llms, requireMd and "
        + "readTimeoutMs belong to agent-browser's plain HTTP fetch, which runs outside the browser and its "
        + `signed-in session and moves no tab. ${OPEN_A_URL}`,
    },
  ],
  [
    "agent_browser_open",
    {
      required: ["url"],
      description: "Load a URL in the browser's current tab, as typing it into the address bar does: a real page load "
        + "with the browser's cookies and signed-in session, and the page it replaces stays in the tab's history for "
        + "agent_browser_back. The result carries the page it loaded, its URL first, so a redirect shows there.",
      refusal: "agent_browser_open needs the address to load in the browser's current tab: without one, or with a "
        + "url that starts with \"-\", which agent-browser's command line reads as a flag, it is agent-browser's launch "
        + "command, and the browser is the ShipBash harness's. Call it again with the address.",
    },
  ],
]);

/** A tool as the harness offers it: its refused arguments out of the schema, its description restated. */
export function withoutRefusedArguments(tool) {
  const rule = REFUSED_ARGUMENTS.get(tool?.name);
  const properties = tool?.inputSchema?.properties;
  if (!rule || !isRecord(properties)) return tool;
  const { fields = [], required = [] } = rule;
  const kept = (Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [])
    .filter((name) => !fields.includes(name));
  const inputSchema = {
    ...tool.inputSchema,
    properties: Object.fromEntries(Object.entries(properties).filter(([name]) => !fields.includes(name))),
    required: [...new Set([...kept, ...required])],
  };
  return { ...tool, description: rule.description, inputSchema };
}

/** Whether the CLI reads `value` as the argument itself: a non-empty string, never a flag. */
const positional = (value) => typeof value === "string" && value !== "" && !value.startsWith("-");

/** The refusal a call sending a refused argument, or not carrying a required one, has earned, or undefined. */
function refusedArgumentsRefusal(request) {
  const params = isRecord(request.params) ? request.params : {};
  const rule = REFUSED_ARGUMENTS.get(params.name);
  const args = isRecord(params.arguments) ? params.arguments : {};
  const { fields = [], required = [] } = rule ?? {};
  return request.method === "tools/call" && rule
    && (fields.some((name) => args[name] !== undefined) || required.some((name) => !positional(args[name])))
    ? rule.refusal
    : undefined;
}

// Launch config, browser state, and raw CLI args are harness-owned the same
// way the lifecycle is — erased from every call and schema by the argument
// policy in agent-browser-arg-policy.mjs.

/**
 * The refusal a call to a tool outside the catalogue has earned, or undefined
 * for a tool in it: the harness chose this run's browser tools, so the agent
 * continues with them.
 */
function refusedTool(name) {
  if (typeof name !== "string" || OFFERED_TOOLS.has(name)) return undefined;
  return TOOL_REFUSALS.get(name) ?? `${name} is not available in this run: the ShipBash harness curates the browser tool `
    + "surface for this task. Continue with the tools in your catalogue.";
}

/** The one refusal a request has earned, or undefined to let it through. */
export function refusalFor(request) {
  const name = request.method === "tools/call" && isRecord(request.params) ? request.params.name : undefined;
  return refusedTool(name)
    ?? refusedArgumentsRefusal(request)
    ?? (evalInteractionAttempt(request) ? EVAL_INTERACTION_REFUSAL : undefined);
}

export function blockedToolResponse(id, message) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: message }], isError: true },
  });
}
