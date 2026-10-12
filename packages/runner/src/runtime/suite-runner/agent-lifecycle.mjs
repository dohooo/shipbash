// How a case agent's session becomes Case events: prompt building and the
// projection of pi's session events that keeps everything downstream of the
// Runner agnostic to the engine.
import { isBackgroundTerminalCall, surfaceForTool } from "@shipbash/contracts/runtime/attention-track.mjs";
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";
import { agentActionSummary } from "../agent-actions.mjs";

import { mcpServerOf } from "../pi-data-sources.mjs";
import { redactEventValue } from "./redaction.mjs";
import { emit } from "./state.mjs";

/**
 * The supervising agent's stdin prompt: the brief, opening with the case's
 * history note when there is one. A teardown learns what the Journey before it
 * did from that note and from read_history, not from a summary pasted into
 * its brief. The note is this agent's alone: it points at list_history and
 * read_history, which Jev has not got, and beside the page an earlier walk's
 * verdict moved Jev's own. Told the previous run had verified a checkpoint,
 * Jev failed it on a page that showed it; told this
 * run's first walk had failed it, the reproduction failed it too, 10 times in
 * 10 (measured).
 * @param {string} brief
 * @param {string | null} [historyNote]
 */
export function buildCasePrompt(brief, historyNote = null) {
  return historyNote ? `${historyNote}\n\n${brief}` : brief;
}

// The server name the agent's browser tools live under: the runner's builder
// names it, and the evidence-capture filters read it, so it exists exactly once.
export { BROWSER_SOURCE } from "../tools.mjs";

function safeToolName(value) {
  if (typeof value !== "string") {
    return "browser_tool";
  }
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(value) ? value : "browser_tool";
}

/**
 * The session a terminal call's answer names (runner terminal-tools.mjs
 * answers with the screen as JSON): the one a terminal_run opened, which its
 * arguments cannot name. Null for any other answer.
 */
function answeredSessionId(tool, event) {
  if (surfaceForTool(tool) !== "terminal" || event.isError) return null;
  const text = event.result?.content?.[0]?.text;
  try {
    const sessionId = typeof text === "string" ? JSON.parse(text)?.sessionId : undefined;
    return typeof sessionId === "string" && sessionId ? sessionId : null;
  } catch {
    return null;
  }
}

/**
 * What a finished MCP tool call reports: which call it was, which tool ran on
 * which server with which arguments and for how long (`ms`, on the monotonic
 * clock), whether it succeeded, the redacted action it amounts to, and for a
 * terminal call the session its answer names.
 * @param {{ args: unknown, startedAt: number }} call
 */
function toolCompletion(event, call, tool, server, actionId) {
  const sessionId = answeredSessionId(tool, event);
  return {
    actionId: actionId ?? null,
    tool,
    succeeded: !event.isError,
    observation: redactEventValue(agentActionSummary(tool, call.args)),
    server: safeToolName(server),
    arguments: isRecord(call.args) ? call.args : {},
    ms: performance.now() - call.startedAt,
    ...(sessionId ? { sessionId } : {}),
  };
}

/**
 * The `agent_action_*` payload one tool event projects. Only an MCP tool call
 * names a tool and a server; only its completion half claims an outcome.
 */
function agentActionPayload(context, actionId, tool, server, started, succeeded) {
  return {
    ...context,
    actionId,
    actionKind: server ? "browser_tool" : "helper_command",
    ...(server
      ? {
          tool,
          mcpServer: safeToolName(server),
          ...(started ? {} : { succeeded }),
          // A tool that failed says so in its own words, or the reader sees a
          // row that reads exactly like the ones that worked. The sentence
          // names the tool and stops there: arguments carry the secrets.
          ...(started || succeeded ? {} : { message: `The ${tool} tool failed.` }),
        }
      : {}),
  };
}

/** A failed response, rowed as a failed agent action: each attempt pi retried included. */
function turnFailure(event, context) {
  if (event.message.stopReason !== "error") return;
  emit("agent", "agent_action_failed", { ...context, actionKind: "agent", message: "The agent reported an execution error." });
}

/**
 * The call a tool event belongs to: the arguments it was made with and the
 * monotonic reading it started at. pi's end event carries neither, so a
 * call's start keeps them in `running` until its end takes them; an end whose
 * start was never seen is taken as it comes, started where it ended.
 * @param {Map<string, { args: unknown, startedAt: number }>} running
 * @returns {{ args: unknown, startedAt: number }}
 */
function toolCall(running, event, actionId) {
  if (event.type === "tool_execution_start") {
    const call = { args: event.args, startedAt: performance.now() };
    if (actionId !== undefined) running.set(actionId, call);
    return call;
  }
  const call = actionId === undefined ? undefined : running.get(actionId);
  running.delete(actionId);
  return call ?? { args: event.args, startedAt: performance.now() };
}

/**
 * One agent's projection of its pi session: a tool call starting and ending
 * becomes the agent_action pair, a failed response the agent_action_failed
 * row; the failure a run ends on is runPiAgent's (pi-agent.mjs). `sources` names the
 * source each wrapped tool came from (runner tools.mjs), and a tool of pi's
 * MCP extension names its server (`mcp__<server>__<tool>`); any other tool is
 * pi's own. A call on a background shell is rowed as a helper command, as
 * pi's own are: it drove no surface the run shows, and the run page follows
 * the agent by a row's tool (console run-agent-surface.ts).
 * @param {Record<string, unknown>} context
 * @param {Map<string, string>} sources
 * @param {(completion: Record<string, unknown>) => void} [onToolCompleted]
 * @returns {(event: Record<string, any>) => void}
 */
export function piLifecycleProjector(context, sources, onToolCompleted = () => {}) {
  /** @type {Map<string, { args: unknown, startedAt: number }>} */
  const running = new Map();
  return (event) => {
    if (event.type === "message_end" && event.message?.role === "assistant") {
      turnFailure(event, context);
      return;
    }
    if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") return;
    const started = event.type === "tool_execution_start";
    const tool = safeToolName(event.toolName);
    // A tool pi's MCP extension registered names its server itself.
    const server = sources.get(tool) ?? mcpServerOf(tool) ?? undefined;
    const actionId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    const call = toolCall(running, event, actionId);
    if (!started && server) onToolCompleted(toolCompletion(event, call, tool, server, actionId));
    const background = surfaceForTool(tool) === "terminal" && isBackgroundTerminalCall(call.args);
    emit("agent", started ? "agent_action_started" : "agent_action_completed",
      agentActionPayload(context, actionId, tool, background ? undefined : server, started, !event.isError));
  };
}
