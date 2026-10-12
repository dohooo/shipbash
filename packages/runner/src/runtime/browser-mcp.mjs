// The browser as every lane's agent reaches it: agent-browser's MCP server
// behind ShipBash's proxy (agent-browser-mcp-proxy.mjs), spawned for the
// session and read through pi's MCP client, which owns the protocol: the
// handshake and its version, a listing's pages, each call's timeout and
// cancellation, and shutting the proxy down. A call answers as the model
// reads it: its text parts joined, then each image it saved — a screenshot,
// which the proxy passes as a link to its file — scaled down for the model
// (screenshot-image.mjs). A result the server marks as an error is a tool
// failure in its own words; a timeout, an abort or a protocol error reads as
// the runner's own stdio client worded it.
import { fileURLToPath } from "node:url";

import { McpAbortError, McpClient, McpError, McpTimeoutError, StdioTransport } from "@earendil-works/pi-mcp";

import { downscaledScreenshot } from "./screenshot-image.mjs";

/** What the handshake and the listing may take; each call brings its own budget. */
const SETUP_TIMEOUT_MS = 120_000;
/** The name the runner's stdio client gave the proxy in the failures the model read. */
const SERVER = "agent-browser";

/**
 * @typedef {{ name: string, description?: string, inputSchema?: Record<string, unknown> }} ListedTool
 * @typedef {{ type: "text", text: string } | { type: "image", data: string, mimeType: string }} ToolContent
 * @typedef {{
 *   callTool(name: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<ToolContent[]>,
 *   close(): Promise<unknown>,
 * }} BrowserServer the proxy as the runner calls it: each call's answer as the model reads it
 */

/**
 * An answer's text as the model reads it: the text, or "(no output)".
 * @param {string} text
 * @returns {ToolContent[]}
 */
export function toolContent(text) {
  return [{ type: "text", text: text || "(no output)" }];
}

/**
 * The images a result links to, each read from its file and scaled down;
 * one that cannot be is left out.
 * @param {import("@earendil-works/pi-mcp").CallToolResult} result
 * @param {AbortSignal} [signal]
 * @returns {Promise<ToolContent[]>}
 */
async function linkedImages(result, signal) {
  const files = result.content.flatMap((part) => (part.type === "resource_link" && part.mimeType?.startsWith("image/") && part.uri.startsWith("file:")
    ? [fileURLToPath(part.uri)] : []));
  const images = await Promise.all(files.map((path) => downscaledScreenshot(path, signal)));
  return images.filter((image) => image !== null);
}

/**
 * A failed call as the runner's own stdio client reported it, before pi's
 * client replaced it: the proxy named before a timeout, an abort and a
 * protocol error. Anything else is pi's own failure.
 * @param {unknown} error @param {number} timeoutMs
 */
function callFailure(error, timeoutMs) {
  if (error instanceof McpTimeoutError) return new Error(`${SERVER}: tools/call timed out after ${String(timeoutMs)}ms.`);
  if (error instanceof McpAbortError) return new Error(`${SERVER}: tools/call was aborted.`);
  if (error instanceof McpError) return new Error(`${SERVER}: ${error.message}`);
  return error;
}

/**
 * Starts the proxy with exactly `env` and lists its tools. `opened` hears the
 * server before the handshake, so a failure anywhere can still close it.
 * @param {{ script: string, env: Record<string, string> }} proxy
 * @param {(server: BrowserServer) => void} opened
 * @returns {Promise<{ server: BrowserServer, listed: ListedTool[] }>}
 */
export async function openBrowserServer({ script, env }, opened) {
  const client = new McpClient({ name: "shipbash-pi-lane", version: "1.0.0", requestTimeoutMs: SETUP_TIMEOUT_MS });
  /** @type {BrowserServer} */
  const server = {
    async callTool(name, args, timeoutMs, signal) {
      const result = await client.callTool(name, args, { timeoutMs, signal }).catch((error) => {
        throw callFailure(error, timeoutMs);
      });
      const text = result.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
      if (result.isError) throw new Error(text || `${name} failed.`);
      return [...toolContent(text), ...await linkedImages(result, signal)];
    },
    close: () => client.close(),
  };
  opened(server);
  await client.connect(new StdioTransport({ command: "node", args: [script], env, inheritEnv: false, stderr: "inherit" }));
  return { server, listed: await client.listTools() };
}
