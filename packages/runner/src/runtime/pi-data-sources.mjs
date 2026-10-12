// A session's data sources, read through pi's own MCP extension
// (pi-sdk.mjs openAgentSession): each source is a remote MCP server pi
// connects as the session starts, its token a pi provider read on every
// request, its tools `mcp__<name>__*`. A source that cannot be connected
// leaves the session without its tools and says why through the source's own
// `onUnavailable`.
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * The MCP server a tool pi's MCP extension registered came from, named in its
 * `mcp__<server>__<tool>`; null for any other tool.
 * @param {string} name
 * @returns {string | null}
 */
export function mcpServerOf(name) {
  return /^mcp__(.+?)__/u.exec(name)?.[1] ?? null;
}

/** Per request, so a hung server costs one bounded wait, not pi's default minute. */
const REQUEST_TIMEOUT_SECONDS = 20;
/** The most of one result a session reads whole; pi alone cuts at 20KB. */
const OUTPUT_CAP_BYTES = 100 * 1024;

/**
 * A data source the agent reads through pi's MCP extension: a remote MCP
 * server, named so its tools are `mcp__<name>__*`, with the headers that
 * select its tools, a token pi asks for on every request, and how its tools
 * reach the model. `direct` declares them on every request, which a session
 * that resumes a transcript needs: pi restores no tool tool_search loaded, so
 * a deferred tool a resumed session loads again changes the declared tools
 * and misses the cached prefix. `deferred` keeps them undeclared until
 * tool_search loads them, the cheaper choice for a session that never
 * resumes.
 * @typedef {{
 *   name: string,
 *   description: string,
 *   url: string,
 *   headers: Record<string, string>,
 *   exposure: "direct" | "deferred",
 *   token: () => Promise<string>,
 *   onUnavailable: (reason: string) => void,
 * }} DataSource
 */

/** @param {unknown} error */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {DataSource} source */
function tokenProviderId(source) {
  return `shipbash-${source.name}`;
}

/**
 * Each data source's token as a pi provider of its own, which pi's MCP
 * extension reads on every HTTP request to the server (`auth: { provider }`):
 * a refreshed token reaches the next request with no reconnect. It serves no
 * model. Registered on the session's own model runtime, so concurrent
 * sessions in one process never read each other's. pi reads a failed token
 * as none and reports only that the server wants a sign-in, so the failure
 * itself is kept in `failures` for the warning to carry.
 * @param {{ registerNativeProvider: (provider: any) => void }} modelRuntime
 * @param {readonly DataSource[]} sources
 * @param {Map<string, string>} failures
 */
export function registerTokenProviders(modelRuntime, sources, failures) {
  for (const source of sources) {
    const servesNoModel = () => {
      throw new Error(`${source.name} serves no model.`);
    };
    const resolve = async () => {
      try {
        const apiKey = await source.token();
        failures.delete(source.name);
        return { auth: { apiKey } };
      } catch (error) {
        failures.set(source.name, errorText(error));
        throw error;
      }
    };
    modelRuntime.registerNativeProvider({
      id: tokenProviderId(source),
      name: source.name,
      auth: { apiKey: { name: `${source.name} token`, resolve } },
      getModels: () => [],
      stream: servesNoModel,
      streamSimple: servesNoModel,
    });
  }
}

/**
 * pi cuts an MCP result over 20KB in its middle and leaves the whole of it in
 * a temporary file for pi's read builtin, which no ShipBash session holds.
 * The result is read back whole, up to OUTPUT_CAP_BYTES, the file removed and
 * pi's pointer to it dropped.
 * @param {{ toolName: string, details?: unknown, content: NonNullable<import("@earendil-works/pi-coding-agent").ToolResultEventResult["content"]> }} event
 * @returns {Promise<import("@earendil-works/pi-coding-agent").ToolResultEventResult | undefined>}
 */
export async function wholeOutput(event) {
  const details = event.details;
  const path = typeof details === "object" && details !== null ? Reflect.get(details, "fullOutputPath") : undefined;
  if (!event.toolName.startsWith("mcp__") || typeof path !== "string") return undefined;
  const full = await readFile(path).finally(() => rm(path, { force: true }));
  const text = full.byteLength > OUTPUT_CAP_BYTES
    ? `${full.subarray(0, OUTPUT_CAP_BYTES).toString("utf8")}\n\n[Cut at 100KB of ${String(full.byteLength)} bytes; narrow the path or use search_code.]`
    : full.toString("utf8");
  return { content: [{ type: "text", text }, ...event.content.filter((part) => part.type === "image")] };
}

/**
 * The inline extensions a session reads its data sources through, none for a
 * session without: pi's MCP extension, with no `mcp.json` read from the agent
 * directory or the cwd and its log kept in the session's agent directory; the
 * tool_search it activates for deferred servers; each source registered as a
 * server; and the whole of a result pi would cut.
 * @param {typeof import("@earendil-works/pi-coding-agent")} pi
 * @param {string} agentDir
 * @param {readonly DataSource[]} sources
 * @returns {import("@earendil-works/pi-coding-agent").InlineExtension[]}
 */
export function dataSourceExtensions(pi, agentDir, sources) {
  if (sources.length === 0) return [];
  return [
    pi.createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }), logPath: join(agentDir, "mcp.log") }),
    pi.createToolSearchExtension(),
    (api) => {
      for (const source of sources) {
        api.registerMcpServer(source.name, {
          url: source.url, headers: source.headers, description: source.description,
          auth: { provider: tokenProviderId(source) }, exposure: source.exposure, timeout: REQUEST_TIMEOUT_SECONDS,
        });
      }
      api.on("tool_result", wholeOutput);
    },
  ];
}

/**
 * pi's MCP extension reports the servers it could not connect once, through
 * its UI's notify, a line `  <name>: <state>` each, or that MCP could not load
 * at all; a session has no UI but this one, which hands each named source its
 * reason: the token's own failure when it had one, else pi's state. Any other
 * notice is no data source's.
 * @param {import("@earendil-works/pi-coding-agent").AgentSession} session
 * @param {readonly DataSource[]} sources
 * @param {Map<string, string>} failures
 * @returns {import("@earendil-works/pi-coding-agent").ExtensionUIContext}
 */
export function unavailableSourcesUi(session, sources, failures) {
  return {
    ...session.extensionRunner.getUIContext(),
    notify: (message) => {
      const loadFailure = /^MCP failed to load: (.+)$/su.exec(message)?.[1];
      const states = new Map(message.split("\n").flatMap((line) => {
        const named = /^\s+([^:\s]+): (.+)$/u.exec(line);
        return named?.[1] && named[2] ? [[named[1], named[2]]] : [];
      }));
      for (const source of sources) {
        const state = loadFailure ?? states.get(source.name);
        if (state) source.onUnavailable(failures.get(source.name) ?? state);
      }
    },
  };
}
