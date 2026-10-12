// The browser tools every agent is offered, in every lane: of agent-browser's
// ~150 MCP tools, what a user's hands and eyes can do, and the readers a
// report quotes from. The daemon itself keeps running `mcp --tools all` — the
// proxy's own synthetic calls (snapshot merges, pointer boxes, reachability
// probes) need the full surface — but the catalogue served to the agent and
// the calls accepted from it are these (runner agent-browser-catalogue.mjs).
// Two reasons, in order: the `all` catalogue exposes harness-owned switches
// (state, recording, streaming, install, sessions) whose misuse can swap the
// browser under a run, and it costs ~67k tokens of every model
// request, where these cost ~10k (agent-browser 0.38.1). The capability table
// names them as the browser row (capabilities.mjs).
//
// The interaction tools: navigate, look (snapshot/read/screenshot), act, wait,
// and handle the tabs, frames, and dialogs a product opens. `eval` stays
// because the reachability policy already restricts it to reading;
// `wait_for_function` stays out because it runs arbitrary JS without passing
// that policy. `open` loads a URL in the current tab. It was left out
// when agent-browser launched Chromium itself and an open relaunched it under
// the run; now every call joins the harness's browser, which
// agent-browser can no longer close or replace, and open with a url is the
// daemon's navigate, through the same join as a click. Its launch half — no
// url, or a launch setting — is refused by the proxy.
const INTERACTION_SUFFIXES = [
  "open", "back", "forward", "reload", "read", "snapshot",
  "click", "dblclick", "fill", "type", "press", "check", "uncheck", "select", "hover", "focus",
  "scroll", "scroll_into_view", "drag", "upload",
  "wait_ms", "wait_for_selector", "wait_for_text", "wait_for_url", "wait_for_load",
  "screenshot", "get_text", "get_url", "get_title", "get_value", "get_attr", "is_visible", "is_enabled", "is_checked",
  "tab_new", "tab_list", "tab_switch", "tab_close", "frame_switch", "frame_main",
  "dialog_status", "dialog_accept", "dialog_dismiss", "eval",
];
// The evidence readers: console output, page errors, and the request log, to
// quote the failing call. A Journey run reports defects with them, and so does
// a walk the chat sends to find out whether checkout is broken.
const EVIDENCE_SUFFIXES = ["console", "errors", "network_requests", "network_request"];

/** The catalogue's tool names, as agent-browser's MCP server names them. */
export const BROWSER_TOOLS = Object.freeze([...INTERACTION_SUFFIXES, ...EVIDENCE_SUFFIXES].map((suffix) => `agent_browser_${suffix}`));
