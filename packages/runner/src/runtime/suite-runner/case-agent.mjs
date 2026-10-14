// Running the agent itself: one agent turn per case attempt, plus the
// read-only code-evidence pass a confirmed failure earns. Both consume the
// invocation builders and hand their raw output to the case-results
// validators.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { startAgentPointerChannelReader } from "../agent-pointer.mjs";
import { isHookRole } from "@shipbash/contracts/runtime/case-role-contract.mjs";
import { agentServices, REVIEW_MODEL_CONTRACT } from "@shipbash/contracts/runtime/agent-model.mjs";
import { browserGoneCaseResult, browserUnresponsiveCaseResult, timedOutCaseResult, unfinishedSupervisionResult } from "../case-verdicts.mjs";
import { buildCaseProductionPromptForRuntime, buildCodeEvidenceProductionPromptForRuntime, caseJourneyBriefForRuntime } from "@shipbash/contracts/runtime/production-prompts.mjs";
import { startNarrationReader } from "../recording-narration.mjs";
import { historyPathsFrom, readCaseRoute } from "../history-records.mjs";
import { progressOptions } from "../progress-session.mjs";
import { caseOpeningNote } from "../history-tools.mjs";
import { isJevCall } from "../jev-tools.mjs";
import { NOT_RETAINED } from "../evidence-recorder.mjs";

import {
  CASE_SCHEMA_PATH,
  CODE_EVIDENCE_SCHEMA_PATH,
  CONTROL_ROOT,
  OUTPUT_ROOT,
  POINTER_CHANNEL_PATH,
  WORK_DIRECTORY,
} from "./environment.mjs";
import { safeError } from "./redaction.mjs";
import { CancellationError, emit, pollCancelRequested } from "./state.mjs";
import { AGENT_ABORT_CANCEL, AGENT_ABORT_TIMEOUT, createAgentBudget, runPiAgent } from "../pi-agent.mjs";
import { runJevCaseAgent } from "../jev-verification.mjs";
import { scenarioPrompt } from "@shipbash/contracts/runtime/pi-session-prompts.mjs";
import { BROWSER_SOURCE, buildCasePrompt, piLifecycleProjector } from "./agent-lifecycle.mjs";
import { BROWSER_UNRESPONSIVE, caseEvidenceGate } from "./case-evidence-gate.mjs";
import { BROWSER_GONE } from "./case-source-watch.mjs";
import { caseGitHub } from "./case-github.mjs";
import { createCaseTooling, watchExtensionTools } from "./case-tooling.mjs";
import {
  deliveryRefusal,
  reconcileCaseAgentResult,
  sameChecklist,
  startChecklistProgressReader,
  validateCaseResult,
  validateCodeEvidenceResult,
} from "./case-results.mjs";

/**
 * Tails the pointer channel the MCP proxy writes and republishes each pointer
 * as an `agent_pointer` event plus a recording cue. The proxy resolves
 * coordinates BEFORE forwarding the action, so receipt time is the causal
 * anchor — the cursor leads the click instead of trailing it.
 * @param {(pointer: object) => void} [onPointer] the attempt's recording, which places it
 */
export function startCasePointerReader(context, onPointer = () => {}) {
  return startAgentPointerChannelReader(POINTER_CHANNEL_PATH, (pointer) => {
    emit("browser", "agent_pointer", { ...context, ...pointer });
    onPointer(pointer);
  });
}

/**
 * Points the progress and narration channels at files beside the result the
 * agent will write, seeds the checklist it starts from, and tells the history
 * tools where this run's walks are and which case is being walked.
 * @param {string} resultPath where the agent writes its structured result
 * @param {ReadonlyArray<Record<string, unknown>> | null} initialChecklist the
 * checklist to seed, when a previous attempt left one
 * @param {string} caseId the case being walked
 * @param {import("../progress-session.d.mts").TerminalAnswerer | null} terminal the attempt's terminal lane
 * @returns {{ narrationPath: string, progressPath: string, progress: import("../progress-session.d.mts").LaneProgressOptions }}
 * the two channels, and the progress tools' options
 */
function caseProgress(resultPath, initialChecklist, caseId, terminal) {
  const directory = resultPath.slice(0, resultPath.lastIndexOf("/"));
  const progressPath = join(directory, "checklist-events.jsonl");
  const narrationPath = join(directory, "narration-events.jsonl");
  const progress = progressOptions({
    controlRoot: CONTROL_ROOT, eventPath: progressPath, narrationPath, initialChecklist, terminal, outputRoot: OUTPUT_ROOT, caseId,
  });
  return { narrationPath, progressPath, progress };
}

/**
 * The verdict an agent run that delivered no document earns: an `error`,
 * which is ShipBash's own failure and never the product's — a model call the
 * gateway refused included. A timeout is judged before this, by what the walk
 * had reported (case-verdicts.mjs timedOutCaseResult).
 * @param {{ code: number }} result how the turn ended: 0 when it delivered its document
 * @param {string | null} agentFailure the failure the run ended on, if any (pi-agent.mjs)
 * @returns {Record<string, unknown> | null} the verdict, or null when the run
 * ended cleanly enough for its structured result to be read
 */
function failedCaseAgentResult(result, agentFailure) {
  if (result.code !== 0) {
    return {
      outcome: "error",
      authState: "unknown",
      summary: "The case agent did not complete successfully.",
      failureReason: agentFailure
        ?? "The case agent delivered no result.",
      keyActions: [],
      checklist: [],
    };
  }
  return null;
}

/**
 * Reads the structured result the agent wrote, reconciles it against the
 * progress the reporting tool announced, and says so when the two disagreed.
 * A document that cannot be read or validated becomes a verdict of its own
 * rather than an exception the caller has to interpret.
 * @param {string} resultPath the file the agent was told to write
 * @param {{ checklist: unknown, revision: number }} reported progress truth
 * @param {ReadonlyArray<Record<string, unknown>> | null} initialChecklist the
 * checklist this attempt started from
 * @param {Record<string, unknown>} context the case identity events carry
 * @returns {Promise<Record<string, unknown>>} the case result
 */
async function readCaseAgentResult(resultPath, reported, initialChecklist, context) {
  try {
    const parsed = validateCaseResult(JSON.parse(await readFile(resultPath, "utf8")));
    const validated = reconcileCaseAgentResult(parsed, reported, initialChecklist);
    if (reported.revision > 0 && !sameChecklist(reported.checklist, validated.checklist)) {
      emit("case", "case_checklist_updated", {
        ...context,
        checklist: validated.checklist,
        source: "structured_result",
      });
    }
    return validated;
  } catch (error) {
    return {
      outcome: "error",
      authState: "unknown",
      summary: "The case agent returned an invalid structured result.",
      failureReason: safeError(error),
      keyActions: [],
      checklist: [],
    };
  }
}

const JOURNEY_AGENT_TIMEOUT_MS = 20 * 60_000;
// A hook sets or clears one state; a walk that needs longer is not one.
const HOOK_AGENT_TIMEOUT_MS = 5 * 60_000;

/** A Case with a hook role; a Case that carries no role is a Journey. */
function isHook(testCase) {
  return typeof testCase.role === "string" && isHookRole(testCase.role);
}

export function caseAgentTimeoutMs(testCase) {
  return isHook(testCase) ? HOOK_AGENT_TIMEOUT_MS : JOURNEY_AGENT_TIMEOUT_MS;
}

/** Every tool result reaches the walk's step record, with who made the call. */
function caseToolWatch(walk) {
  return (_server, tool, text, call) => {
    void walk?.step({
      actor: isJevCall(call?.toolCallId) ? "jev" : "supervisor",
      tool,
      args: call?.args,
      text,
      failed: call?.failed === true,
    });
  };
}

/** The note the brief opens with when this case has history, or null, and the route of its newest passing walk (Jev's). */
function caseHistory(testCase) {
  const paths = historyPathsFrom({ controlRoot: CONTROL_ROOT, outputRoot: OUTPUT_ROOT, caseId: testCase.id });
  return paths ? Promise.all([caseOpeningNote(paths, { hook: isHook(testCase) }), readCaseRoute(paths)]) : [null, []];
}

/**
 * The verdict of a walk stopped before its end, or null when it ran to it; a
 * cancel throws. A supervising turn that ended undelivered after Jev observed
 * a failure is judged by what was reported since, unless it overruled Jev.
 * The browser is the cause when it went, gone or silent — the agent's missing
 * result is only its shadow — and a timeout outranks the exit code it came
 * with, judged by what the walk had reported.
 */
function stoppedWalkResult({ aborted, observed }, checklist, gate, testCase) {
  if (aborted === AGENT_ABORT_CANCEL) throw new CancellationError();
  const unfinished = observed ? unfinishedSupervisionResult(observed, checklist) : null;
  if (unfinished) return unfinished;
  if (aborted === BROWSER_GONE) return browserGoneCaseResult(checklist, testCase.checkpoints);
  if (aborted === BROWSER_UNRESPONSIVE) return browserUnresponsiveCaseResult(gate.silentMs(), checklist, testCase.checkpoints);
  if (aborted === AGENT_ABORT_TIMEOUT) return timedOutCaseResult(checklist);
  return null;
}

export async function runCase(
  suite,
  testCase,
  caseRunId,
  attempt,
  executionRound,
  env,
  resultPath,
  initialChecklist = null,
  onNarration = () => {},
  onPointer = () => {},
  budget,
  // With no recorder, a browser step keeps no picture.
  onToolCompleted = (completion) => (completion.server === BROWSER_SOURCE ? Promise.resolve(NOT_RETAINED) : undefined),
  walk = null,
  // The attempt's terminal lane, which answers the terminal trio and which Jev reads beside the page.
  terminal = null,
  // The attempt's credential control, which answers get_credentials.
  credentials = null,
  // On a reproduction, the first walk's result (journey-confirmation.mjs).
  firstWalk = null,
) {
  const context = { caseRunId, caseId: testCase.id, attempt, executionRound };
  const selection = { model: suite.modelContract.model, reasoningEffort: suite.modelContract.reasoningEffort,
    serviceTier: agentServices(process.env).model.serviceTier ?? undefined, surface: isHook(testCase) ? "hook" : "case" };
  emit("agent", "agent_model_selected", { ...context, ...selection, message: "Case agent configuration recorded." });
  const { narrationPath, progressPath, progress } = caseProgress(resultPath, initialChecklist, testCase.id, terminal);
  const [historyNote, route] = await caseHistory(testCase);
  const progressReader = await startChecklistProgressReader(progressPath, context, initialChecklist);
  const narrationReader = await startNarrationReader(narrationPath, onNarration);
  const pointerReader = startCasePointerReader(context, onPointer);
  let result;
  let reported;
  const gate = caseEvidenceGate(context, budget, onToolCompleted);
  try {
    const watch = caseToolWatch(walk);
    const tooling = await createCaseTooling(suite, env, progress, { onToolResult: watch, credentials });
    // The GitHub reads pi's MCP extension serves reach the walk from the session's events.
    const watchGitHub = watchExtensionTools(watch);
    try {
      // Jev's constraints are the Journey's part of the brief: the rest of it, and the history note, are the supervising agent's.
      const brief = buildCaseProductionPromptForRuntime(suite, testCase, initialChecklist);
      const { systemPrompt, appendSystemPrompt } = scenarioPrompt("case", tooling.rows);
      const lifecycle = piLifecycleProjector(context, tooling.sources, gate.capture);
      result = await runJevCaseAgent({
        modelContract: suite.modelContract,
        deliveryRefusal: deliveryRefusal(progressPath, initialChecklist),
        systemInstructions: systemPrompt,
        appendSystemPrompt,
        prompt: buildCasePrompt(brief, historyNote),
        schema: JSON.parse(await readFile(CASE_SCHEMA_PATH, "utf8")),
        resultPath,
        cwd: WORK_DIRECTORY,
        customTools: tooling.tools,
        dataSources: tooling.dataSources,
        signal: budget.signal,
        scratchDirectory: WORK_DIRECTORY,
        onEvent: (event) => {
          watchGitHub(event);
          lifecycle(event);
        },
        // Each model response's tokens, under the selection the walk announced.
        onUsage: (counts) => emit("agent", "agent_usage", { ...context, ...selection, ...counts }),
      }, {
        testCase, constraints: caseJourneyBriefForRuntime(suite, testCase), env, context, initialChecklist, walk, firstWalk, route,
        onToolEvent: gate.jevToolEvents(tooling.sources),
        readTerminal: () => terminal?.screen() ?? null,
      });
    } finally {
      await tooling.close();
    }
  } finally {
    reported = await progressReader.stop();
    await narrationReader.stop();
    await pointerReader.stop();
  }
  const stopped = stoppedWalkResult(result, reported.checklist, gate, testCase);
  if (stopped) return stopped;
  const failure = failedCaseAgentResult({ code: result.delivered ? 0 : 1 }, result.failure);
  if (failure) {
    return failure;
  }
  return readCaseAgentResult(resultPath, reported, initialChecklist, context);
}

export async function runCodeEvidence(suite, testCase, original, reproduction, caseRunId) {
  const github = suite.repositoryCommitSha ? caseGitHub(suite) : null;
  if (!github) {
    emit("case", "code_evidence_unavailable", {
      caseRunId,
      caseId: testCase.id,
      message: "No bound repository commit was available; the confirmed failure remains actionable.",
    });
    return null;
  }
  const resultPath = join(OUTPUT_ROOT, caseRunId, "code-evidence.json");
  const context = { caseRunId, caseId: testCase.id };
  const selection = { ...REVIEW_MODEL_CONTRACT, surface: "code_evidence", serviceTier: agentServices(process.env).model.serviceTier ?? undefined };
  emit("agent", "agent_model_selected", { ...context, ...selection, message: "Code evidence inspector configuration recorded." });
  emit("case", "code_evidence_started", {
    ...context,
    repositoryCommitSha: suite.repositoryCommitSha,
    message: "Inspecting the linked repository read-only for file-level corroboration.",
  });
  const budget = createAgentBudget({ timeoutMs: 5 * 60_000, isCancelRequested: pollCancelRequested });
  try {
    // The inspector reads the bound repository on GitHub at the run's commit;
    // nothing else is offered, and the result document is delivered.
    const execution = await runPiAgent({
      modelContract: REVIEW_MODEL_CONTRACT,
      systemInstructions:
        "Read the bound repository only through its GitHub tools, which tool_search loads, at the commit your brief names; your tools cannot write or run code. Cite only evidence you read there.",
      prompt: buildCodeEvidenceProductionPromptForRuntime(suite, testCase, original, reproduction),
      schema: JSON.parse(await readFile(CODE_EVIDENCE_SCHEMA_PATH, "utf8")),
      resultPath,
      cwd: WORK_DIRECTORY,
      customTools: github.tools,
      dataSources: [github.dataSource],
      signal: budget.signal,
      scratchDirectory: WORK_DIRECTORY,
      onEvent: piLifecycleProjector(context, new Map()),
      onUsage: (counts) => emit("agent", "agent_usage", { ...context, ...selection, ...counts }),
    });
    if (execution.aborted === AGENT_ABORT_CANCEL) throw new CancellationError();
    if (execution.aborted === AGENT_ABORT_TIMEOUT) throw new Error("Code evidence inspection timed out.");
    if (!execution.delivered) {
      throw new Error(execution.failure ?? "The code evidence inspector delivered no document.");
    }
    const validated = validateCodeEvidenceResult(JSON.parse(await readFile(resultPath, "utf8")));
    const evidence = {
      ...validated,
      commitSha: suite.repositoryCommitSha,
    };
    emit("case", "code_evidence_completed", {
      ...context,
      repositoryCommitSha: suite.repositoryCommitSha,
      status: evidence.status,
      fileCount: evidence.files.length,
      message: evidence.summary,
    });
    return evidence;
  } catch (error) {
    if (error instanceof CancellationError) throw error;
    emit("case", "code_evidence_unavailable", {
      ...context,
      repositoryCommitSha: suite.repositoryCommitSha,
      message: `Repository corroboration was unavailable: ${safeError(error)}`,
    });
    return null;
  } finally {
    budget.dispose();
  }
}
