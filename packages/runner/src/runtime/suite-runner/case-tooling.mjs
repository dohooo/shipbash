// The case agent's tools, as pi custom tools: the rows resolved for a case
// (contracts capabilities.mjs) — the browser proxy with the batch over its
// tools, the progress tools' checklist, narration, terminal trio, run history
// and recall, the credential tool when a sign-in is on offer, and the bound
// repository on GitHub when the suite names one (case-github.mjs): its
// deployments tool here, its MCP server a data source the session reads
// through pi's MCP extension — built by the runner's builder (tools.mjs). Each
// tool remembers the source it came from, so the lifecycle projection can
// name it.
import { resolve } from "@shipbash/contracts/runtime/capabilities.mjs";

import { availableSignIns } from "../credentials-control.mjs";
import { caseGitHub } from "./case-github.mjs";
import { sourceTools } from "../pi-agent.mjs";
import { screencastBlackedOut } from "../screencast-blackout.mjs";
import { TERMINAL_TOOL_NAMES } from "../terminal-tools.mjs";
import { GITHUB_SOURCE } from "../github-source.mjs";
import { mcpServerOf } from "../pi-data-sources.mjs";
import { BROWSER_SOURCE, openRunnerTools, PROGRESS_SOURCE } from "../tools.mjs";
import { AGENT_BROWSER_MCP_ENV_VARS, RUNTIME_DIRECTORY } from "./environment.mjs";

const BROWSER_TOOL_TIMEOUT_MS = 2 * 60_000;
const TERMINAL_TOOL_TIMEOUT_MS = 10 * 60_000;
const QUICK_TOOL_TIMEOUT_MS = 25_000;

/**
 * Shows the caller every tool result on its way back to whichever agent asked
 * for it, with the call that produced it. Both agents call the same `execute`
 * — pi through its custom-tool loop, Jev through jevToolCaller — so this one
 * seam sees both. A call that threw is shown too: an error never proves that
 * the input was not sent.
 */
function watched(server, tool, onToolResult) {
  const { execute } = tool;
  return {
    ...tool,
    execute: async (toolCallId, params, signal) => {
      const call = { toolCallId, args: params, failed: false };
      let result;
      try {
        result = await execute(toolCallId, params, signal);
      } catch (error) {
        onToolResult(server, tool.name, error instanceof Error ? error.message : String(error), { ...call, failed: true });
        throw error;
      }
      const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      onToolResult(server, tool.name, text, { ...call, failed: result.isError === true });
      return result;
    },
  };
}

/**
 * The tools pi's own extensions register — an MCP server's `mcp__<server>__*`
 * and the tool_search that loads them — never pass through `watched`: the
 * caller sees their results from the session's events instead, each with the
 * call that produced it.
 * @param {(server: string, tool: string, text: string, call: { toolCallId: string, args: unknown, failed: boolean }) => void} onToolResult
 * @returns {(event: Record<string, any>) => void}
 */
export function watchExtensionTools(onToolResult) {
  /** @type {Map<string, unknown>} */
  const started = new Map();
  return (event) => {
    const server = event.toolName === "tool_search" ? "pi" : mcpServerOf(String(event.toolName));
    if (!server) return;
    if (event.type === "tool_execution_start") started.set(event.toolCallId, event.args);
    if (event.type !== "tool_execution_end" || !started.has(event.toolCallId)) return;
    const args = started.get(event.toolCallId);
    started.delete(event.toolCallId);
    const content = Array.isArray(event.result?.content) ? event.result.content : [];
    const text = content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
    onToolResult(server, event.toolName, text, { toolCallId: event.toolCallId, args, failed: event.isError === true });
  };
}

const SCREENSHOT_TOOL = "agent_browser_screenshot";
const SCREENSHOT_WITHHELD = "No screenshot while a one-time code may be on screen: the screen stays hidden until the code expires. Read the page with agent_browser_snapshot instead.";

/**
 * The agent's own screenshot, refused while a one-time code may be on
 * screen: its file lands in the case's artifact directory, where the run
 * keeps it as a key screenshot.
 */
function withheldWhileBlackedOut(tool) {
  if (tool.name !== SCREENSHOT_TOOL) return tool;
  const { execute } = tool;
  return {
    ...tool,
    execute: async (toolCallId, params, signal) => {
      if (screencastBlackedOut()) throw new Error(SCREENSHOT_WITHHELD);
      return execute(toolCallId, params, signal);
    },
  };
}

/** Each source's budget: the terminal trio may watch a long command. */
function timeoutFor(source, name) {
  if (source === BROWSER_SOURCE) return BROWSER_TOOL_TIMEOUT_MS;
  if (source === PROGRESS_SOURCE && TERMINAL_TOOL_NAMES.includes(name)) return TERMINAL_TOOL_TIMEOUT_MS;
  return QUICK_TOOL_TIMEOUT_MS;
}

/**
 * What the host bound for this run: the repository the suite names, and the
 * saved sign-ins the credential broker serves. A case's recording is its one
 * Journey's, never cut to marks.
 * @param {{ repository?: unknown }} suite
 * @returns {import("@shipbash/contracts/runtime/capabilities.mjs").Bindings}
 */
export function caseBindings(suite) {
  return { repository: suite.repository != null, signIns: availableSignIns().length > 0, recording: false };
}

/**
 * @param {{
 *   repository?: { owner: string, name: string, defaultBranch: string } | null,
 * }} suite
 * @param {Record<string, string | undefined>} env
 * @param {import("../progress-session.d.mts").LaneProgressOptions} progress the progress tools' options for this case (progress-session.mjs progressOptions)
 * @param {{
 *   onToolResult?: (server: string, tool: string, text: string, call: { toolCallId: string, args: unknown, failed: boolean }) => void,
 *   credentials?: import("../tools.mjs").Lane["credentials"],
 *   openBrowser?: import("../tools.mjs").Lane["openBrowser"],
 * }} [options] `credentials`: the attempt's credential control; `openBrowser` stands in for the browser proxy
 * @returns {Promise<{ tools: Array<Record<string, unknown>>, dataSources: import("../pi-data-sources.mjs").DataSource[], sources: Map<string, string>, rows: readonly string[], close: () => Promise<unknown> }>}
 *   `rows`: the case's resolved capability rows, whose prompt text its session appends
 */
export async function createCaseTooling(suite, env, progress, { onToolResult = null, credentials = null, openBrowser } = {}) {
  const resolved = resolve("case", caseBindings(suite));
  const built = await openRunnerTools(resolved, env, {
    runtimeDirectory: RUNTIME_DIRECTORY,
    browserEnv: AGENT_BROWSER_MCP_ENV_VARS,
    progress,
    credentials,
    // The bound repository on GitHub; the watcher sees its deployments tool's results too.
    github: () => {
      const github = caseGitHub(suite);
      return github && { ...github, tools: github.tools.map((tool) => (onToolResult ? watched(GITHUB_SOURCE, tool, onToolResult) : tool)) };
    },
    ...(openBrowser ? { openBrowser } : {}),
    // One timeout per tool; a screenshot is held back while a code may be on screen, and the watcher sees every result.
    wrap: (name, source, listed) => listed.flatMap((tool) => sourceTools(source, [tool], timeoutFor(name, tool.name)))
      .map(withheldWhileBlackedOut)
      .map((wrapped) => (onToolResult ? watched(name, wrapped, onToolResult) : wrapped)),
  });
  return { ...built, rows: resolved.rows };
}
