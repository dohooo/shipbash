// How the Activity's tools become the pi session's hands: its resolved
// capability rows, built by the runner's builder (tools.mjs), each source's
// tools wrapped as pi custom tools: the answer's text verbatim, errors as
// tool failures, the abort signal reaching the call so a timeout or a cancel
// settles it at once instead of waiting out the tool budget. This module also
// owns the per-tool budget table and the wait-progress plumbing for the tools
// whose whole job is waiting on a human or the host.
import { availableSignIns, startCredentialControl } from "../credentials-control.mjs";
import { activityGitHub } from "./activity-github.mjs";
import { registerCredentialValues } from "./redaction.mjs";
import { appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { jevDiscoveryTool } from "../jev-discovery.mjs";
import { flushActivityStepCapture } from "./evidence-capture.mjs";
import { redactString } from "./redaction.mjs";
import { OUTPUT_ROOT } from "./environment.mjs";
import { join } from "node:path";

import { agentServices } from "@shipbash/contracts/runtime/agent-model.mjs";
import { resolve } from "@shipbash/contracts/runtime/capabilities.mjs";

import { progressOptions } from "../progress-session.mjs";
import { BROWSER_SOURCE, openRunnerTools, PROGRESS_SOURCE } from "../tools.mjs";
import {
  AGENT_BROWSER_MCP_ENV_VARS,
  CANCEL_PATH,
  HUMAN_AUTH_CANCEL_PATH,
  HUMAN_AUTH_COMPLETE_PATH,
  HUMAN_AUTH_REQUEST_PATH,
  HUMAN_AUTH_RESUMED_PATH,
  HUMAN_AUTH_TOOL_TIMEOUT_SECONDS,
  NARRATION_PATH,
  PROGRESS_PATH,
  RUNTIME_DIRECTORY,
} from "./environment.mjs";
import { ENTRY_CHECK_OWNER_NOTE } from "../entry-check.mjs";
import { deliverResultTool } from "./pi-result.mjs";
import { terminalActionEmitter } from "./terminal-actions.mjs";
import { checkCancellation, emit, inflightBrowserCall } from "./state.mjs";

const BROWSER_TOOL_TIMEOUT_MS = 240_000;
// The terminal tools ride a host-answered channel and may legitimately watch
// a long-running command; 240s was a real bug.
const LONG_TOOL_TIMEOUT_MS = 15 * 60_000;
const WAIT_PROGRESS_TICK_MS = 60_000;
// Progress events start once a wait is genuinely long and stay sparse.
export const WAIT_PROGRESS_EVENT_MINUTES = 5;
/** Tools whose whole job is waiting on a human or the host; they get the
 * long budget, pause the session clock, and report their wait as progress. */
export const WAITING_TOOLS = new Set(["request_choice"]);
/**
 * The bookkeeping tools: they touch no page and decide
 * nothing, so several of them in one turn may run at once. pi turns the whole
 * batch sequential the moment any tool in it is marked sequential
 * (pi-agent-core agent-loop), which is what keeps a turn's browser action
 * ordered against everything else — this set only lets a turn of pure
 * bookkeeping settle in parallel. Waiting, terminating, and journey-writing
 * tools stay out: a wait holds the round, a handoff ends it, and the Journey
 * store is one file several calls would race for.
 */
export const BOOKKEEPING_TOOLS = new Set([
  "record_knowledge",
  "recall_knowledge",
  "list_history",
  "read_history",
  "publish_narrative",
  "publish_update",
  "publish_narration",
]);
/** Tools whose call is the round's final act: pi stops after
 * the tool batch that contains one, exactly as it does for deliver_result.
 * request_authentication files the handoff and parks the round; nothing the
 * model might add afterwards can reach the conversation, so the closing
 * words ride the same message. */
export const TERMINATING_TOOLS = new Set(["request_authentication"]);

/**
 * While a waiting tool is in flight, ticks pi's onUpdate (the official
 * partial-result stream) once a minute so the wait is visible, not silent.
 * @param {((partial: { content: Array<{ type: "text", text: string }>, details: { waitingMinutes: number } }) => void) | undefined} onUpdate
 */
function startWaitProgress(onUpdate) {
  let minutes = 0;
  const timer = setInterval(() => {
    minutes += 1;
    onUpdate?.({
      content: [{ type: "text", text: `Still waiting — ${String(minutes)}m.` }],
      details: { waitingMinutes: minutes },
    });
  }, WAIT_PROGRESS_TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
/**
 * Opens one waiting-tool span: pauses the session clock (pi-session-clock.mjs)
 * and starts the per-minute progress ticks. Returns the closer; a non-waiting
 * tool gets a no-op.
 */
function beginToolWait(name, clock, onUpdate) {
  if (!WAITING_TOOLS.has(name)) return () => {};
  clock?.pause();
  const stopProgress = startWaitProgress(onUpdate);
  return () => {
    stopProgress();
    clock?.resume();
  };
}

/**
 * Wraps one source's tools as pi custom tools. The answer goes back to
 * the model verbatim, images included, and errors surface as tool failures. The abort signal
 * reaches the call so a timeout or cancel settles it immediately instead of
 * waiting out the tool budget. Once the cancel sentinel is down no call
 * starts: the session's own abort follows within a poll (cancellation.mjs
 * `watchCancel`), and nothing may act on the product before it.
 * @param {import("../tools.mjs").ToolSource} source
 * @param {Array<{ name: string, description?: string, inputSchema?: Record<string, unknown> }>} tools
 * @param {(name: string) => number} timeoutFor
 * `onActionStart` fires before the call leaves, `onAction` once with its
 * outcome and the call's id: pi's for the agent's own calls, `jev:<n>` for
 * Jev's (jev-tools.mjs).
 * @param {{ onUrl?: (url: string) => void, clock?: { pause: () => void, resume: () => void }, onActionStart?: (name: string, args: Record<string, unknown>) => void, onAction?: (name: string, args: Record<string, unknown>, ms: number, state: "ok" | "fail", toolCallId: string) => void, inflight?: { current: { name: string, at: number } | null } }} [hooks]
 */
export function wrapSourceTools(source, tools, timeoutFor, { onUrl, clock, onActionStart, onAction, inflight } = {}) {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description ?? tool.name,
    parameters: tool.inputSchema && typeof tool.inputSchema === "object" && tool.inputSchema.type === "object"
      ? tool.inputSchema
      : { type: "object", properties: {}, additionalProperties: true },
    executionMode: BOOKKEEPING_TOOLS.has(tool.name) ? "parallel" : "sequential",
    execute: async (toolCallId, params, signal, onUpdate) => {
      checkCancellation();
      const args = params ?? {};
      if (onUrl && typeof args.url === "string") onUrl(args.url);
      const finishWait = beginToolWait(tool.name, clock, onUpdate);
      if (inflight) inflight.current = { name: tool.name, at: Date.now() };
      // The call's length on the monotonic clock, the one the walk's recording places it by (recording-capture.mjs).
      const started = performance.now();
      const ms = () => Math.round(performance.now() - started);
      onActionStart?.(tool.name, args);
      try {
        const content = await source.callTool(tool.name, args, timeoutFor(tool.name), signal);
        onAction?.(tool.name, args, ms(), "ok", toolCallId);
        return {
          content,
          details: undefined,
          ...(TERMINATING_TOOLS.has(tool.name) ? { terminate: true } : {}),
        };
      } catch (error) {
        onAction?.(tool.name, args, ms(), "fail", toolCallId);
        throw error;
      } finally {
        if (inflight) inflight.current = null;
        finishWait();
      }
    },
  }));
}
/**
 * The entry check at the Activity lane's acceptance point (entry-check.mjs): a
 * conclusion that the sign-in did not persist — request_authentication, or
 * deliver_result with auth_required — is refused once when the leg has only
 * seen the doorstep. The refusal is a tool ERROR the model reads and acts on,
 * never a result: a non-error request_authentication result would end the
 * round (stopsAfterHandoff). The second call goes through unchanged.
 * @template {{ name: string, execute: (...args: any[]) => Promise<any> }} T
 * @param {T} tool
 * @param {{ review: () => Promise<string | null> } | null} entryCheck
 * @param {(params: any) => boolean} concludes whether this call is such a conclusion
 * @param {typeof emit} [emitEvent]
 * @returns {T}
 */
export function guardConclusion(tool, entryCheck, concludes, emitEvent = emit) {
  if (!entryCheck) return tool;
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const refusal = concludes(params) ? await entryCheck.review() : null;
      if (refusal) {
        emitEvent("warning", "ShipBash asked the agent to check the signed-in entry before concluding", {
          bodyMarkdown: ENTRY_CHECK_OWNER_NOTE,
          safeData: { event: "entry_check_refused", category: "authentication_persistence", tool: tool.name },
        });
        throw new Error(refusal);
      }
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}
/** The progress tools' per-tool budget: request_choice waits on a human
 * (up to the auth window), synthesis and the terminal tools wait on the host
 * for minutes, request_authentication files its request and returns at once
 * (and ends the round, see TERMINATING_TOOLS) — everything else gets the
 * ordinary budget. */
function progressToolTimeout(name) {
  if (name === "request_choice") return (HUMAN_AUTH_TOOL_TIMEOUT_SECONDS + 60) * 1000;
  if (name === "terminal_run" || name === "terminal_read") {
    return LONG_TOOL_TIMEOUT_MS;
  }
  return BROWSER_TOOL_TIMEOUT_MS;
}
/**
 * What the host bound for this leg, as its input and its task API carry it:
 * the repository is named to the leg whenever the project's binding is ready,
 * checked out or not, the saved sign-ins are those the credential broker
 * serves, and the leg records its screen when its input says recordScreen.
 * @param {{ repository?: unknown, recordScreen?: boolean }} activity
 * @returns {import("@shipbash/contracts/runtime/capabilities.mjs").Bindings}
 */
export function activityBindings(activity) {
  return { repository: activity.repository != null, signIns: availableSignIns().length > 0, recording: activity.recordScreen === true };
}

/** The leg's capability rows and tools (contracts capabilities.mjs). */
export function activityCapabilities(activity) {
  return resolve(activity.kind, activityBindings(activity));
}

/**
 * How the Activity wraps each source's tools: the browser reports its actions
 * and the pages it opens, the progress tools pause the clock on a wait and
 * report their terminal actions, and request_authentication is held to the
 * entry check (guardConclusion).
 */
function activityWrap({ onUrl, clock, onActionStart, onAction, entryCheck }) {
  const terminalActions = terminalActionEmitter();
  return (name, source, listed) => {
    if (name === BROWSER_SOURCE) {
      return wrapSourceTools(source, listed, () => BROWSER_TOOL_TIMEOUT_MS, { onUrl, onActionStart, onAction, inflight: inflightBrowserCall });
    }
    if (name === PROGRESS_SOURCE) {
      return wrapSourceTools(source, listed, progressToolTimeout, { clock, ...terminalActions })
        .map((tool) => (tool.name === "request_authentication" ? guardConclusion(tool, entryCheck, () => true) : tool));
    }
    return wrapSourceTools(source, listed, () => 25_000);
  };
}

/**
 * The leg's in-process tools: deliver_result, the end of an unattended kind's
 * round, and browser_execute_goal, Jev over the tools built before it, with
 * the leg's terminal as Jev reads it beside the page (its newest session or
 * null), as a Journey run's Jev reads it (jev-verification.mjs).
 */
function activityInProcess(env, { holder, checkDelivery, entryCheck, revision, terminal }) {
  return {
    deliver_result: async () => guardConclusion(await deliverResultTool(holder, checkDelivery), entryCheck, (params) => params?.status === "auth_required"),
    browser_execute_goal: (built) => {
      emit("lifecycle", "Browser goal execution available", { safeData: { event: "jev_delegation_available" } });
      return jevDiscoveryTool({ jev: agentServices(env).jev, tools: built, redact: (text) => redactString(text, Infinity),
        revision, readTerminal: () => terminal.screen(), stopping: () => existsSync(join(env.SHIPBASH_CONTROL_ROOT, "wrapup")),
        afterAction: flushActivityStepCapture,
        retain: (text) => appendFile(join(OUTPUT_ROOT, "jev-execution.jsonl"), `${text}\n`, { mode: 0o600 }),
        onDecision: (selection) => emit("evidence", "Jev decision", {
          safeData: { event: "jev_decision", ...selection },
        }),
      });
    },
  };
}

/**
 * The leg's tools, exactly its resolved rows (runner tools.mjs): the browser
 * proxy, the progress tools on the leg's channels — a narration channel only
 * when the leg records its screen — with its terminal lane
 * (`terminal`) answering their terminal, and the credential tool on the leg's
 * credential control, wrapped for pi; the leg's in-process tools; and the
 * bound repository on GitHub, a data source the session reads through pi's
 * MCP extension (activity-github.mjs).
 */
export async function createHarnessTooling(activity, env, { resolved, onUrl, holder, checkDelivery, clock, onActionStart, onAction, entryCheck = null, revision = () => 0, terminal }) {
  const credentialControl = await startCredentialControl({
    registerSecrets: registerCredentialValues,
    onUnmasked: (name) => emit("warning", `The saved sign-in's ${name} is too short to mask in this run's logs`, {
      safeData: { event: "credential_unmasked", value: name },
    }),
  });
  const built = await openRunnerTools(resolved, env, {
    runtimeDirectory: RUNTIME_DIRECTORY,
    browserEnv: AGENT_BROWSER_MCP_ENV_VARS,
    progress: progressOptions({
      controlRoot: env.SHIPBASH_CONTROL_ROOT, eventPath: PROGRESS_PATH, terminal,
      narrationPath: activity.recordScreen === true ? NARRATION_PATH : null,
      humanAuth: {
        requestPath: HUMAN_AUTH_REQUEST_PATH, completePath: HUMAN_AUTH_COMPLETE_PATH, cancelPath: HUMAN_AUTH_CANCEL_PATH,
        resumedPath: HUMAN_AUTH_RESUMED_PATH, runCancelPath: CANCEL_PATH,
      },
    }),
    credentials: credentialControl,
    github: () => activityGitHub(activity),
    wrap: activityWrap({ onUrl, clock, onActionStart, onAction, entryCheck }),
    inProcess: activityInProcess(env, { holder, checkDelivery, entryCheck, revision, terminal }),
  }).catch(async (error) => {
    await credentialControl?.close();
    throw error;
  });
  return {
    customTools: built.tools,
    dataSources: built.dataSources,
    sources: built.sources,
    close: () => Promise.allSettled([built.close(), credentialControl?.close()]),
  };
}
