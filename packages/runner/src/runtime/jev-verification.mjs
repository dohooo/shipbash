import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { agentServices } from "@shipbash/contracts/runtime/agent-model.mjs";
import { isJourneyRole } from "@shipbash/contracts/runtime/case-role-contract.mjs";
import { runPiAgent } from "./pi-agent.mjs";
import { executeJevGoal, supervisorRecord } from "./jev-executor.mjs";
import { jevToolCaller } from "./jev-tools.mjs";
import { jevJson } from "./jev-actions.mjs";
import { stepsSummary } from "./jev-steps.mjs";
import { JEV_SETTLE_PICTURE } from "./suite-runner/case-evidence-gate.mjs";
import { emit } from "./suite-runner/state.mjs";
import { redactString, safeError } from "./suite-runner/redaction.mjs";

const redact = (text) => redactString(text, Infinity);

function supportsCase(testCase, initialChecklist) {
  return (
    testCase.checkpoints?.length > 0 &&
    testCase.checkpoints.length <= 12 &&
    !initialChecklist?.some((item) => item.status !== "pending")
  );
}

function documentFrom(result) {
  const failed = result.status === "failed";
  const outcome = failed ? "failed" : "passed";
  const goals = result.checklist
    .filter((item) => item.status === (failed ? "failed" : "passed"))
    .map((item) => item.goal)
    .join("; ");
  const reason = `${failed ? "Observed checkpoint failure" : "Verified"}: ${goals}`.slice(0, 300);
  return {
    outcome,
    authState: "unknown",
    summary: reason,
    failureReason: failed ? reason : null,
    keyActions: result.history.filter((item) => item.status === "completed").map((item) => item.action),
    checklist: result.checklist.map((item) => ({
      ...item,
      status: item.status === "pending" ? "not_run" : item.status,
      reason: item.status === "failed" ? reason : null,
    })),
  };
}

/** The shape a cut-short walk owes its caller: nothing delivered, and the reason why. */
function abortedResult(signal) {
  return { delivered: false, document: null, failure: null, aborted: String(signal.reason) };
}

/**
 * Jev's report of one checkpoint it settled. A checkpoint the page
 * contradicts is a hook's failure; on a Journey it stays in_progress for the
 * supervising agent to judge, and what Jev saw goes to that agent in the
 * handoff (handoffPrompt): a checklist keeps a reason on failed and blocked
 * alone (contracts checklist-contract.mjs, valid_case_checklist).
 */
function checkpointReport(checkpoint, journey) {
  if (checkpoint.status !== "failed") return { id: checkpoint.id, status: checkpoint.status };
  return journey
    ? { id: checkpoint.id, status: "in_progress" }
    : { id: checkpoint.id, status: "failed", reason: "Observed state contradicts this checkpoint; see retained page evidence." };
}

/**
 * The supervising agent's brief for the rest of the attempt: its own, then
 * where Jev left the walk, and on a Journey's contradicted checkpoint, that
 * the verdict on it is the agent's.
 */
function handoffPrompt(prompt, result, contradicted, firstWalk) {
  const checkpoint = contradicted ? result.checklist.find((item) => item.status === "failed") : null;
  const verdict = checkpoint
    ? ` Jev read checkpoint ${checkpoint.id} as contradicted by the page and reported it in_progress. Its verdict is yours: judge that checkpoint, and whether each of the Journey's preconditions held when the walk began. A precondition did not hold only when the walk saw that state itself; this checkpoint failing is never that sighting.`
    : "";
  const first = checkpoint && firstWalk
    ? ` This walk is the reproduction of a first walk, from a clean start, in which Jev observed: ${firstWalk.failureReason ?? firstWalk.summary}. No one judged that first walk: your verdict on this one settles the Journey.`
    : "";
  return `${prompt}\nContinue this SAME attempt from its current page. Inspect before acting; never replay completed or uncertain operations.${verdict}${first} ${stepsSummary(result.steps)} Retained progress and observations:\n${jevJson(supervisorRecord(result), redact)}`;
}

async function runSupportedCase(options, config, deps) {
  const signal = options.signal;
  const call = jevToolCaller(options.customTools, { signal, onEvent: config.onToolEvent });
  const journey = isJourneyRole(config.testCase.role);
  const result = await executeJevGoal(
    {
      goal: config.testCase.title,
      steps: config.testCase.steps,
      // A Journey is a procedure: every step taken; a hook is a state (jev-walk-steps.mjs walkSteps).
      everyStep: journey,
      // The case's brief, never the supervising agent's prompt: that one opens
      // with the history note, which is not Jev's to read (agent-lifecycle.mjs).
      constraints: config.constraints,
      checkpoints: config.testCase.checkpoints,
    },
    {
      jev: agentServices(config.env).jev,
      signal,
      call,
      // The route of the case's newest passing walk, as the case agent read it (history-records.mjs readCaseRoute).
      route: config.route,
      // The walk's last step keeps its picture before the walk is over (suite-runner/case-evidence-gate.mjs).
      settle: () => config.onToolEvent?.({ type: JEV_SETTLE_PICTURE }),
      choose: deps.choose,
      motionMaxMs: deps.motionMaxMs,
      judge: deps.judge,
      readTerminal: config.readTerminal,
      redact,
      onDecision: (selection) =>
        emit("agent", "jev_decision", {
          ...config.context,
          ...selection,
          message: `Jev ${selection.kind}: ${selection.choice ?? "supervisor inspection needed"}.`,
        }),
      onCheckpoint: (checkpoint) => call("report_checklist", { updates: [checkpointReport(checkpoint, journey)] }),
    },
  );
  emit("agent", "jev_execution_summary", {
    ...config.context,
    status: result.status,
    reason: result.reason,
    reasonCode: result.reasonCode,
    requests: result.requests,
    durationMs: result.decisions.reduce((sum, item) => sum + (item.durationMs ?? 0), 0),
    message: `Jev made ${result.requests} requests; ${result.status}.`,
  });
  const recordPath = config.env.AGENT_BROWSER_SCREENSHOT_DIR
    ? join(config.env.AGENT_BROWSER_SCREENSHOT_DIR, "jev-execution.json")
    : `${options.resultPath}.jev.json`;
  await writeFile(recordPath, jevJson(result, redact), { mode: 0o600 });
  if (signal.aborted) return abortedResult(signal);
  // A Journey's failure is the supervising agent's to deliver: Jev reads one
  // checkpoint on one page and cannot tell a product that contradicts it from
  // a walk that began where the Journey's preconditions did not hold. Two CLI
  // Journeys meant to start signed out began signed in, and their walks
  // reported the CLI's "Status: Logged in" as a product failure. A hook's
  // preconditions never gate its verdict, so its failure stays Jev's.
  const contradicted = result.status === "failed" && journey;
  // A first walk's contradicted checkpoint is walked again from a clean start
  // before anyone judges it (journey-confirmation.mjs): the supervising agent
  // judges once, on the reproduction, with what this walk observed. A
  // reproduction that passes clears it, as a re-run that passes always has.
  if (contradicted && !config.firstWalk) return deliverJevDocument(options, call, result);
  if (result.status === "handoff" || contradicted) {
    await config.walk?.handoff(result.reason);
    // The handoff continues on the caller's own signal: the same budget, the
    // same cancel sentinel, no second clock to disagree with the first.
    const supervised = await (deps.runAgent ?? runPiAgent)({ ...options, prompt: handoffPrompt(options.prompt, result, contradicted, config.firstWalk) });
    // A supervising turn that ends undelivered — its time ran out, the model
    // gateway or the browser failed — hands its caller Jev's observed failure,
    // which the caller weighs against what was reported since
    // (case-verdicts.mjs unfinishedSupervisionResult).
    return contradicted && !supervised.delivered ? { ...supervised, observed: documentFrom(result) } : supervised;
  }
  return deliverJevDocument(options, call, result);
}

/** Jev's own result, reported and written as the walk's. */
async function deliverJevDocument(options, call, result) {
  const document = documentFrom(result);
  await call("report_checklist", {
    updates: document.checklist.map(({ id, status, reason }) => ({ id, status, ...(reason ? { reason } : {}) })),
  });
  await writeFile(options.resultPath, JSON.stringify(document), { mode: 0o600 });
  return { delivered: true, document, failure: null, aborted: null };
}

/** The same fixed-case path accepts Journey and configured setup/teardown roles. */
export async function runJevCaseAgent(options, config, deps = {}) {
  if (!supportsCase(config.testCase, config.initialChecklist)) return (deps.runAgent ?? runPiAgent)(options);
  try {
    return await runSupportedCase(options, config, deps);
  } catch (error) {
    if (options.signal.aborted) return abortedResult(options.signal);
    return { delivered: false, document: null, failure: safeError(error), aborted: null };
  }
}
