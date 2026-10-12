// What the runner's lanes and the host share about a lane's browser.
//
// Where it is named for the host: the runner's harness
// (packages/runner/src/runtime/harness-browser.mjs) writes the browser's CDP
// address here once it listens; the host reads it once per container and
// hands it to every `docker exec agent-browser` call as AGENT_BROWSER_CDP, so
// the host's calls name the browser exactly as the lane's own do.
export const LANE_BROWSER_CDP_URL_PATH = "/run/agent-browser/cdp-url";

// WebMCP off. With it on, a page can register tools of its own and
// agent-browser hands them to the agent (its webmcp_* tools, and a `webmcp`
// block on its answers); the runner drives a page only as a user would.
// agent-browser counts the setting in its connection's identity, so every
// call to a lane's daemon carries it: defined once here, it is spread into
// both lanes' environments (suite-runner/browser.mjs,
// activity-runner/browser.mjs) and the human-auth viewer's launch, passed on
// by both MCP allowlists, and sent with the host's calls into a lane
// (control-plane lane-browser.ts). The harness launches Chromium without
// WebMCP's features to match.
export const LANE_WEBMCP_ENV = Object.freeze({ AGENT_BROWSER_NO_WEBMCP: "1" });
