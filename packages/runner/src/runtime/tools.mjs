// The runner's builder: a Sandbox agent's tools, built for exactly the
// capability rows resolved for it (contracts capabilities.mjs) and nothing
// else. A tool comes from one of the runner's sources (RUNNER_SOURCES) — the
// browser, agent-browser's MCP server behind ShipBash's proxy, read through
// pi's MCP client (browser-mcp.mjs); ShipBash's own progress and credential
// tools, run in this process (progress-session.mjs, credentials-tool.mjs);
// and GitHub's own MCP server, which the session reads through pi's MCP
// extension (github-source.mjs) — or is one of the lanes' own in-process
// tools. Each lane says how a source's tools are wrapped for its agent:
// timeouts, gates, watchers. The Activity session, the Journey case and the
// sign-in check all assemble through here.
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { BROWSER_TOOLS } from "@shipbash/contracts/runtime/browser-catalogue.mjs";

import { BATCH_TOOL, browserBatchTool } from "./browser-batch.mjs";
import { openBrowserServer, toolContent } from "./browser-mcp.mjs";
import { availableSignIns } from "./credentials-control.mjs";
import { CREDENTIALS_TOOL, credentialsTool } from "./credentials-tool.mjs";
import { GITHUB_SOURCE, GITHUB_SOURCE_TOOLS } from "./github-source.mjs";
import { createProgressTools } from "./progress-session.mjs";
import { PROGRESS_TOOL_NAMES } from "./progress-tools.mjs";

/** The source each tool is attributed to in the run's events; the case's evidence filters read the browser's. */
export const BROWSER_SOURCE = "agent_browser";
export const PROGRESS_SOURCE = "shipbash_progress";
export const CREDENTIALS_SOURCE = "shipbash_credentials";

/**
 * @typedef {import("./browser-batch.mjs").BrowserTool} BuiltTool
 * @typedef {import("./browser-mcp.mjs").ListedTool} ListedTool
 * @typedef {import("./browser-mcp.mjs").ToolContent} ToolContent
 * @typedef {{
 *   callTool(name: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<ToolContent[]>,
 *   close(): Promise<unknown>,
 * }} ToolSource where a lane's tools are executed; a call never answers nothing
 * @typedef {{ close(): Promise<unknown> }} Closable
 * @typedef {{ dataSource: import("./pi-data-sources.mjs").DataSource, tools: BuiltTool[] }} GitHubReads
 * @typedef {{ source: ToolSource, listed: ListedTool[] }} OpenedSource
 * @typedef {{
 *   runtimeDirectory: string,
 *   browserEnv: readonly string[],
 *   progress?: import("./progress-session.d.mts").LaneProgressOptions | null,
 *   credentials?: Parameters<typeof credentialsTool>[0],
 *   wrap: (source: string, tools: ToolSource, listed: ListedTool[]) => BuiltTool[],
 *   github?: () => GitHubReads | null,
 *   inProcess?: Record<string, (built: BuiltTool[]) => BuiltTool | Promise<BuiltTool>>,
 *   openBrowser?: typeof openBrowserServer,
 * }} Lane `credentials`: the run's credential control (credentials-control.mjs)
 * @typedef {{
 *   name: string,
 *   serves: (tool: string) => boolean,
 *   cut: boolean,
 *   open?: (env: Record<string, string | undefined>, lane: Lane, opened: (closable: Closable) => void, tools: readonly string[]) => Promise<OpenedSource>,
 *   dataSource?: (lane: Lane) => GitHubReads | null,
 * }} RunnerSource
 */

/**
 * The runner's sources, in the order their tools are assembled: what each
 * serves, and how it is opened — the browser proxy spawned from the runtime
 * directory with the env names the lane gives it, ShipBash's own tools on the
 * lane's paths and its credential control, or GitHub's access, which the
 * session connects itself. `cut`: its listing can hold more than a run may
 * call, so it is cut to the resolved tools; the browser proxy and GitHub list
 * only their own.
 * @type {readonly RunnerSource[]}
 */
export const RUNNER_SOURCES = Object.freeze([
  {
    name: BROWSER_SOURCE, cut: false,
    serves: (tool) => BROWSER_TOOLS.includes(tool) || tool === BATCH_TOOL,
    open: async (env, lane, opened) => {
      const { server, listed } = await (lane.openBrowser ?? openBrowserServer)({
        script: join(lane.runtimeDirectory, "agent-browser-mcp-proxy.mjs"), env: pickEnvironment(env, lane.browserEnv),
      }, opened);
      return { source: server, listed };
    },
  },
  {
    name: PROGRESS_SOURCE, cut: true,
    serves: (tool) => PROGRESS_TOOL_NAMES.includes(tool),
    // The progress server answered a refusal as a protocol error, which its
    // client named: the model reads it so still.
    // A session that holds add_journey keeps a Journey list of its own, which list_journeys reads beside the record's.
    open: async (_env, lane, opened, held) => {
      const tools = createProgressTools({ ...lane.progress, keepsJourneyList: held.includes("add_journey") });
      const named = { ...tools, call: (name, args) => tools.call(name, args).catch(namedRefusal("shipbash-progress")) };
      return firstParty("shipbash-progress", named, opened);
    },
  },
  {
    name: CREDENTIALS_SOURCE, cut: true,
    serves: (tool) => tool === CREDENTIALS_TOOL,
    open: async (_env, lane, opened) => firstParty("shipbash-credentials", credentialsTool(lane.credentials ?? null, availableSignIns()), opened),
  },
  {
    // Nothing to open: the session's MCP extension connects GitHub's server,
    // and the deployments tool comes built.
    name: GITHUB_SOURCE, cut: false,
    serves: (tool) => GITHUB_SOURCE_TOOLS.includes(tool),
    dataSource: (lane) => lane.github?.() ?? null,
  },
]);

/** @param {Record<string, string | undefined>} env @param {readonly string[]} names */
function pickEnvironment(env, names) {
  /** @type {Record<string, string>} */
  const picked = { PATH: env.PATH ?? process.env.PATH ?? "", HOME: env.HOME ?? process.env.HOME ?? "" };
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string") picked[name] = value;
  }
  return picked;
}

/**
 * A refusal as the stdio client named its server before it.
 * @param {string} server
 * @returns {(error: unknown) => never}
 */
function namedRefusal(server) {
  return (error) => {
    throw new Error(`${server}: ${error instanceof Error ? error.message : String(error)}`);
  };
}

/**
 * `work`'s answer, or the call's failure once `timeoutMs` passes or `signal`
 * aborts, whichever comes first, worded as the stdio client worded it for
 * the server `server`.
 * @template T
 * @param {Promise<T>} work @param {string} server @param {number} timeoutMs @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
function within(work, server, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
    };
    const aborted = () => {
      stop();
      reject(new Error(`${server}: tools/call was aborted.`));
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`${server}: tools/call timed out after ${String(timeoutMs)}ms.`));
    }, timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", aborted, { once: true });
    work.then((value) => { stop(); resolve(value); }, (error) => { stop(); reject(error); });
  });
}

/**
 * How long a call under way at close may go on, as the stdio server these
 * tools were had until its client killed it: a wait that sees the run's
 * cancel sentinel in that time says so, as it did then.
 */
const CLOSE_GRACE_MS = 3_000;

/**
 * ShipBash's own tools as a source, run in this process one call at a time,
 * so the event lines each call appends keep the order of the revisions they
 * carry, which their readers require. A call is bounded by its budget and the
 * caller's signal, and one cut short runs on until it ends; a timeout and an
 * abort read as they read when these tools were the stdio MCP server
 * `server`. Closing the source refuses every call not yet started, gives the
 * call under way CLOSE_GRACE_MS to end, as the killed server's did, and then
 * closes the tools: the progress tools park a wait still under way and write
 * nothing more.
 * @param {string} server
 * @param {{ definitions: ListedTool[], call: (name: string, args: Record<string, unknown>) => Promise<string>, close?: () => void }} tools
 * @param {(closable: Closable) => void} opened
 * @returns {OpenedSource}
 */
function firstParty(server, tools, opened) {
  const aborted = () => new Error(`${server}: tools/call was aborted.`);
  let closed = false;
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @type {ToolSource} */
  const source = {
    callTool(name, args, timeoutMs, signal) {
      if (signal?.aborted || closed) return Promise.reject(aborted());
      const work = queue.then(() => {
        if (closed) throw aborted();
        return tools.call(name, args);
      });
      queue = work.catch(() => undefined);
      return within(work.then((text) => toolContent(text)), server, timeoutMs, signal);
    },
    close: async () => {
      closed = true;
      await Promise.race([queue, delay(CLOSE_GRACE_MS, undefined, { ref: false })]);
      tools.close?.();
    },
  };
  opened(source);
  return { source, listed: tools.definitions };
}

/**
 * Opens every source the resolved tools need, all at once, then assembles
 * their tools in the registry's order — the browser and its batch, the
 * progress tools, the credential tool, GitHub's deployments tool — and then
 * the lane's in-process tools, which see what came before. Returns the tools
 * with the source each came from, and the data sources the session reads
 * through pi's MCP extension. A source or a tool that fails to come up closes
 * every source opened.
 * @param {{ rows: readonly string[], tools: readonly string[] }} resolved
 * @param {Record<string, string | undefined>} env the lane's child environment
 * @param {Lane} lane
 */
export async function openRunnerTools(resolved, env, lane) {
  /** @type {Closable[]} */
  const opened = [];
  const close = () => Promise.allSettled(opened.map((closable) => closable.close()));
  try {
    return { ...await assembleRunnerTools(resolved, env, lane, (closable) => opened.push(closable)), close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** @param {{ rows: readonly string[], tools: readonly string[] }} resolved @param {Record<string, string | undefined>} env @param {Lane} lane @param {(closable: Closable) => void} opened */
async function assembleRunnerTools(resolved, env, lane, opened) {
  const wanted = new Set(resolved.tools);
  const needed = RUNNER_SOURCES.filter((entry) => resolved.tools.some((tool) => entry.serves(tool)));
  const settled = await Promise.allSettled(needed.map(async (entry) => entry.open?.(env, lane, opened, resolved.tools) ?? null));
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  /** @type {BuiltTool[]} */
  const tools = [];
  /** @type {Map<string, string>} */
  const sources = new Map();
  /** @type {import("./pi-data-sources.mjs").DataSource[]} */
  const dataSources = [];
  for (const [index, entry] of needed.entries()) {
    const reads = entry.dataSource?.(lane);
    if (reads) {
      for (const tool of reads.tools) sources.set(tool.name, entry.name);
      tools.push(...reads.tools);
      dataSources.push(reads.dataSource);
    }
    const result = settled[index];
    const source = result?.status === "fulfilled" ? result.value : null;
    if (!source) continue;
    const listed = entry.cut ? source.listed.filter((tool) => wanted.has(tool.name)) : source.listed;
    for (const tool of listed) sources.set(tool.name, entry.name);
    const wrapped = lane.wrap(entry.name, source.source, listed);
    tools.push(...wrapped);
    // The batch runs each call through the lane's wrapped tools, so every call it makes is seen as the call it is.
    if (entry.name === BROWSER_SOURCE) {
      tools.push(browserBatchTool(wrapped));
      sources.set(BATCH_TOOL, BROWSER_SOURCE);
    }
  }
  for (const [name, build] of Object.entries(lane.inProcess ?? {})) {
    if (wanted.has(name)) tools.push(await build([...tools]));
  }
  return { tools, sources, dataSources };
}
