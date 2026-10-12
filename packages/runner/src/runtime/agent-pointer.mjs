/**
 * Shared helpers for Agent pointer telemetry. The MCP proxy resolves the
 * target element's viewport rectangle BEFORE the agent's action is forwarded
 * and publishes it to a shared channel file; the stream proxy and runners
 * tail that channel. Raw selectors never leave the sandbox — only a fixed
 * action vocabulary plus numeric coordinates.
 */
import { statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";
import { AGENT_POINTER_ACTIONS } from "@shipbash/contracts/runtime/agent-pointer-actions.mjs";

/**
 * Browser tools whose target element is worth visualizing as an Agent
 * pointer, each mapped to a verb of the one action vocabulary the playback
 * document keeps (contracts agent-pointer-actions.mjs).
 */
export const AGENT_POINTER_TOOLS = new Map([
  ["agent_browser_click", "click"],
  ["agent_browser_dblclick", "dblclick"],
  ["agent_browser_hover", "hover"],
  ["agent_browser_fill", "fill"],
  ["agent_browser_type", "type"],
  ["agent_browser_check", "check"],
  ["agent_browser_uncheck", "uncheck"],
  ["agent_browser_select", "select"],
  ["agent_browser_focus", "focus"],
  ["agent_browser_scroll_into_view", "scroll"],
]);

/** The shared pointer channel file inside a task's work directory. */
export function agentPointerChannelPath(workDirectory) {
  return join(workDirectory, "agent-pointer-channel.jsonl");
}

/** Parses one pointer channel line, or null when it is not a valid pointer. */
export function parseAgentPointerLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.event !== "agent_pointer") return null;
  const seq = Number(value.seq);
  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);
  if (![seq, x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) return null;
  const at = Number(value.at);
  return {
    seq,
    action: AGENT_POINTER_ACTIONS.find((known) => known === value.action) ?? "click",
    x,
    y,
    width,
    height,
    // Optional source timestamp for latency diagnostics across relay hops.
    ...(Number.isFinite(at) && at > 0 ? { at } : {}),
  };
}

/** The channel's size in bytes, or 0 while it does not exist yet. */
function channelSize(channelPath) {
  try {
    // Synchronous on purpose: a caller starts the reader and then spawns the
    // MCP proxy that writes the channel (case-agent.mjs runCase), so the
    // offset must be fixed before this reader's start returns.
    return statSync(channelPath).size;
  } catch {
    return 0;
  }
}

/** The bytes appended to the channel past `offset`. */
async function readAppended(channelPath, offset) {
  const handle = await open(channelPath, "r");
  try {
    const { size } = await handle.stat();
    if (size <= offset) return Buffer.alloc(0);
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Tails the pointer channel file, invoking `onPointer` for each pointer
 * appended while the reader runs, in order. The channel is one file for the
 * whole task and is never truncated, so the reader starts at its current end
 * (as `tail -n 0 -f` does) and reads only what lands past its offset: each
 * reader, whether a Case's, an Activity turn's or the stream gateway's, hears
 * the pointers of its own lifetime and none written before it started.
 * Polling keeps the reader immune to fs.watch edge cases; the file may not
 * exist yet when the reader starts.
 */
export function startAgentPointerChannelReader(channelPath, onPointer, { intervalMs = 100 } = {}) {
  let offset = channelSize(channelPath);
  let stopped = false;
  let draining = Promise.resolve();

  const drain = async () => {
    let appended;
    try {
      appended = await readAppended(channelPath, offset);
    } catch {
      return;
    }
    const lastNewline = appended.lastIndexOf(0x0a);
    if (lastNewline < 0) return;
    offset += lastNewline + 1;
    for (const line of appended.toString("utf8", 0, lastNewline).split("\n")) {
      if (!line.trim()) continue;
      const pointer = parseAgentPointerLine(line);
      if (pointer) {
        try {
          onPointer(pointer);
        } catch {
          // Pointer delivery is presentation-only; a consumer bug must not
          // stop the channel.
        }
      }
    }
  };

  const timer = setInterval(() => {
    draining = draining.then(drain);
  }, intervalMs);
  timer.unref?.();
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await draining;
      await drain();
    },
  };
}

// ── Proxy-owned box lookup over the daemon pipe ──────────────────────────

/** Id prefix for box lookups the MCP proxy injects into the daemon's stdin. */
export const POINTER_BOX_ID_PREFIX = "__shipbash_box_";
const POINTER_BOX_TIMEOUT_MS = 1_500;

/** The CLI-style `--json` envelope out of an MCP get_box result, or null. */
function boxEnvelope(response) {
  const result = isRecord(response?.result) ? response.result : null;
  if (!result) return null;
  const structured = isRecord(result.structuredContent) ? result.structuredContent.response : null;
  if (isRecord(structured)) return structured;
  const text = Array.isArray(result.content)
    ? result.content.filter((entry) => isRecord(entry) && entry.type === "text").map((entry) => entry.text).join("\n")
    : "";
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Builds the box resolver the MCP proxy's cursor lead uses. Instead of
 * spawning `agent-browser get box` per pointer call, the lookup rides the
 * daemon pipe the proxy already owns: one tools/call to agent_browser_get_box
 * under a proxy-owned id, registered in `pendingRequests` as kind "box" so
 * the proxy's response router hands the reply to `deliver` and never forwards
 * the synthetic id to the agent. Best-effort like its spawn-based
 * predecessor: a write failure, unparsable reply, or timeout resolves null
 * and the action proceeds without a pointer.
 */
export function createPointerBoxResolver(write, pendingRequests) {
  let counter = 0;
  return ({ selector, session, namespace }) => new Promise((resolve) => {
    counter += 1;
    const id = `${POINTER_BOX_ID_PREFIX}${String(counter)}`;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingRequests.delete(id);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), POINTER_BOX_TIMEOUT_MS);
    timer.unref?.();
    pendingRequests.set(id, {
      method: "tools/call",
      kind: "box",
      at: Date.now(),
      deliver: (response) => finish(boxEnvelope(response)),
    });
    const args = { selector };
    if (session) args.session = session;
    if (namespace) args.namespace = namespace;
    try {
      write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "agent_browser_get_box", arguments: args } })}\n`);
    } catch {
      finish(null);
    }
  });
}

/**
 * Normalizes an agent-browser `boundingbox` JSON envelope into a pointer with
 * the element's center point, or null when the geometry is unusable.
 */
export function agentPointerFromBoundingBox(action, value) {
  const data = isRecord(value?.data)
    ? value.data
    : isRecord(value?.result) && isRecord(value.result.data)
      ? value.result.data
      : value;
  const x = Number(data?.x);
  const y = Number(data?.y);
  const width = Number(data?.width);
  const height = Number(data?.height);
  if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) return null;
  return {
    action,
    x: Math.round((x + width / 2) * 100) / 100,
    y: Math.round((y + height / 2) * 100) / 100,
    width: Math.round(width * 100) / 100,
    height: Math.round(height * 100) / 100,
  };
}
