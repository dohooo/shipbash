// One agent turn through the pi session engine, for every surface that runs a
// single turn ending in a delivered document: the suite runner's case agent
// (directly or behind Jev verification), code evidence and sign-in checks.
// The structured result arrives through a `deliver` tool whose parameters are
// the surface's schema (pi validates the arguments, the model retries a bad
// call) and is written to the result file the surface reads. Every way a turn
// can be cut short — the wall-clock budget, the cancel sentinel, a browser the
// daemon swapped under the run — reaches the session as one AbortSignal the
// caller owns (createAgentBudget), and the reason it carries is what the
// caller reads back.
// A lane's tools are handed in already wrapped, so this module knows nothing
// about where they run.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { agentServices } from "@shipbash/contracts/runtime/agent-model.mjs";
import { agentUsageCounts } from "@shipbash/contracts/runtime/agent-usage.mjs";

import { watchCancel } from "./cancellation.mjs";
import { closeAgentSession, deliverTool, loadPiSdk, openAgentSession, subscribeResponseFailure } from "./pi-sdk.mjs";
import { safeError } from "./suite-runner/redaction.mjs";

const DELIVER_DESCRIPTION = "Deliver the final result. Call this exactly once, as the very last thing you do, with the complete document; calling it ends the turn.";

/** The turn ran out of its wall-clock budget. */
export const AGENT_ABORT_TIMEOUT = "timeout";
/** The run was canceled — the one reason that is never a verdict about the product. */
export const AGENT_ABORT_CANCEL = "cancel";

/**
 * One turn's stopping conditions as a single signal the caller owns: the
 * wall-clock budget, the cancel sentinel when the surface has one, and
 * whatever else the caller decides to abort with. `dispose` clears both
 * timers; both are unref'd, so neither holds the process open.
 * @param {{ timeoutMs: number, isCancelRequested?: (() => boolean) | null }} options
 * @returns {{ signal: AbortSignal, abort: (reason: string) => void, dispose: () => void }}
 */
export function createAgentBudget({ timeoutMs, isCancelRequested = null }) {
  const controller = new AbortController();
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const timer = setTimeout(() => abort(AGENT_ABORT_TIMEOUT), timeoutMs);
  timer.unref();
  const poll = isCancelRequested ? watchCancel(isCancelRequested, () => abort(AGENT_ABORT_CANCEL)) : null;
  return {
    signal: controller.signal,
    abort,
    dispose() {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
    },
  };
}

/**
 * A session whose only way to finish is `deliver` must answer with a tool
 * call, never in prose, and that is asked of the model API itself: every
 * model request of the session carries the Responses `tool_choice:
 * "required"`. pi's session forwards no tool choice of its own (the agent
 * loop passes the reasoning level and session id, not `toolChoice`), so this
 * inline extension sets it on the request body through pi's
 * `before_provider_request` hook, which only conversational requests pass.
 * @param {{ on: (event: "before_provider_request", handler: (event: { payload: unknown }) => unknown) => unknown }} pi
 */
function requireToolCall(pi) {
  pi.on("before_provider_request", (event) => (
    event.payload && typeof event.payload === "object" ? { ...event.payload, tool_choice: "required" } : undefined
  ));
}

/**
 * Wraps one source's tools as pi custom tools. The answer goes back to
 * the model verbatim, with any image it carries; an error is a tool failure
 * the model sees.
 * @param {import("./tools.mjs").ToolSource} source
 * @param {Array<{ name: string, description?: string, inputSchema?: Record<string, unknown> }>} tools
 * @param {number} timeoutMs
 */
export function sourceTools(source, tools, timeoutMs) {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description ?? tool.name,
    parameters: tool.inputSchema && typeof tool.inputSchema === "object" && tool.inputSchema.type === "object"
      ? tool.inputSchema
      : { type: "object", properties: {}, additionalProperties: true },
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => ({
      content: await source.callTool(tool.name, params ?? {}, timeoutMs, signal),
      details: undefined,
    }),
  }));
}

/**
 * @param {{
 *   modelContract: { model: string, reasoningEffort: string },
 *   systemInstructions: string,
 *   appendSystemPrompt?: string[],
 *   deliverDescription?: string,
 *   deliveryRefusal?: (params: Record<string, unknown>) => string | null,
 *   prompt: string,
 *   schema: Record<string, unknown>,
 *   resultPath: string,
 *   cwd: string,
 *   customTools?: Array<Record<string, unknown>>,
 *   dataSources?: import("./pi-data-sources.mjs").DataSource[],
 *   signal: AbortSignal,
 *   scratchDirectory: string,
 *   onEvent?: (event: Record<string, any>) => void,
 *   onUsage?: (counts: Record<string, number>) => void,
 *   sdk?: unknown,
 * }} options `appendSystemPrompt` is the prompt text of the session's
 *   resolved capability rows (capabilities.mjs capabilityFragments); `onUsage`
 *   hears each model response's token counters as it ends (agent-usage.mjs),
 *   so a turn cut short keeps what it spent. `failure` is the last response's
 *   error, redacted, or null
 * @returns {Promise<{ delivered: boolean, document: Record<string, unknown> | null, failure: string | null, aborted: string | null }>}
 */
export async function runPiAgent(options) {
  const directory = await mkdtemp(join(options.scratchDirectory, "pi-agent-"));
  const state = { delivered: null, failure: null };
  try {
    const pi = await loadPiSdk(options.sdk);
    const session = await createSession(pi, options, directory, state);
    const stop = watchBudget(session, options.signal);
    try {
      await session.prompt(options.prompt);
    } finally {
      stop();
      await closeAgentSession(session);
    }
    if (state.delivered !== null) await writeFile(options.resultPath, JSON.stringify(state.delivered), { mode: 0o600 });
    return {
      delivered: state.delivered !== null,
      document: state.delivered,
      failure: state.failure,
      aborted: options.signal.aborted ? String(options.signal.reason) : null,
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The turn's session in the one posture (pi-sdk.mjs openAgentSession), on the
 * caller's cwd, with the caller's data sources: the code-evidence inspector's
 * is the bound repository on GitHub.
 */
async function createSession(pi, options, directory, state) {
  const session = await openAgentSession(pi, {
    gateway: agentServices(process.env).model,
    cwd: options.cwd,
    scratchDirectory: directory,
    modelContract: options.modelContract,
    systemPrompt: options.systemInstructions,
    appendSystemPrompt: options.appendSystemPrompt ?? [],
    extensionFactories: [requireToolCall],
    dataSources: options.dataSources,
    session: {
      customTools: [
        ...(options.customTools ?? []),
        deliverTool(options.schema, (params) => { state.delivered = params; }, options.deliverDescription ?? DELIVER_DESCRIPTION, options.deliveryRefusal),
      ],
      sessionManager: pi.SessionManager.create(options.cwd, join(directory, "session")),
    },
  });
  session.subscribe((event) => {
    options.onEvent?.(event);
    if (event.type === "message_end" && event.message?.role === "assistant" && event.message.usage) {
      options.onUsage?.(agentUsageCounts(event.message.usage));
    }
  });
  subscribeResponseFailure(session, (failure) => { state.failure = failure === null ? null : safeError(failure); });
  return session;
}

/** The session follows the caller's signal, whatever reason fires it. */
function watchBudget(session, signal) {
  const abort = () => { void session.abort?.(); };
  if (signal.aborted) {
    abort();
    return () => undefined;
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}
