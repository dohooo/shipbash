// The four setup/teardown slots around a run. A hook is a Case whose role
// is not journey: before_all and after_all walk once per run, before_each and
// after_each around every Journey — or around one Journey only, when the
// hook names it as its scope. Each hook walks in its own browser against
// the run's sign-in state. A non-passed before_all or after_all stops the run;
// a non-passed per-journey hook marks only the Journey it surrounds.
import { isPerJourneyRole, JOURNEY_ROLE } from "@shipbash/contracts/runtime/case-role-contract.mjs";
import { checklistFromCheckpoints } from "@shipbash/contracts/runtime/suite-contract.mjs";

import { sanitizeCaseResultCopy } from "./browser.mjs";
import { executeCaseAttempt } from "./case-attempt.mjs";
import { finalizeCaseBrowserRecording, writeCaseResult } from "./recording-output.mjs";
import { checkCancellation, emit, takeWalkMs } from "./state.mjs";

const HOOK_OUTCOMES = new Set(["passed", "failed", "blocked"]);

/**
 * The run's plan: Journeys in order, each slot in order, and the per-journey
 * overrides keyed by the Journey they name (scopeCaseId is already the
 * sibling Case id of this same input).
 */
export function planSuite(cases) {
  const slot = (role) => cases.filter((entry) => entry.role === role && entry.scopeCaseId === null);
  const overrides = new Map();
  for (const entry of cases) {
    if (!isPerJourneyRole(entry.role) || entry.scopeCaseId === null) continue;
    const own = overrides.get(entry.scopeCaseId) ?? { before: [], after: [] };
    (entry.role === "before_each" ? own.before : own.after).push(entry);
    overrides.set(entry.scopeCaseId, own);
  }
  return {
    journeys: cases.filter((entry) => entry.role === JOURNEY_ROLE),
    beforeAll: slot("before_all"),
    afterAll: slot("after_all"),
    beforeEach: slot("before_each"),
    afterEach: slot("after_each"),
    overrides,
  };
}

/**
 * The hooks around one Journey: Suite-level setup first, then its own; its
 * own teardown first, then Suite-level. Each of their walks names the Journey
 * it surrounds (`journeyCaseId`).
 */
export function hooksAround(plan, testCase) {
  const own = plan.overrides.get(testCase.id) ?? { before: [], after: [] };
  return { before: [...plan.beforeEach, ...own.before], after: [...own.after, ...plan.afterEach], journeyCaseId: testCase.id };
}

/** A hook never reports error: the harness fault blocks it and says why. */
function hookVerdict(result) {
  if (HOOK_OUTCOMES.has(result.outcome)) return result;
  return { ...result, outcome: "blocked", failureReason: result.failureReason ?? result.summary };
}

/** Each walk of a hook keeps its own evidence: its run id names the walk, and so does its output directory. */
export function hookWalkId(hook, walk) {
  return `${hook.id}.walk${String(walk)}`;
}

/**
 * One hook, walked once: announced with its role, executed in a fresh
 * browser, written like any Case under the walk's own directory, and — when
 * it is a teardown that did not pass — raised as attention, since nothing
 * else in the run will say so. Its completion carries what the walk took and,
 * for a before_each or after_each, the Journey it surrounds; a before_all or
 * after_all serves the whole run and names none.
 */
export async function runHook(suite, hook, statePath, walk = 1, journeyCaseId = null) {
  checkCancellation();
  const caseRunId = hookWalkId(hook, walk);
  const context = { caseRunId, caseId: hook.id, attempt: hook.attempt };
  emit("case", "case_started", { ...context, title: hook.title, role: hook.role, scopeCaseId: hook.scopeCaseId });
  const walked = await executeCaseAttempt(
    suite, hook, caseRunId, hook.attempt, 1, statePath, checklistFromCheckpoints(hook.checkpoints),
  );
  await finalizeCaseBrowserRecording(caseRunId, hook.attempt, walked);
  const result = sanitizeCaseResultCopy(
    { ...hookVerdict(walked), trust: { reproducedRuns: 1, codeEvidence: null } },
    context,
  );
  const resultPath = await writeCaseResult(caseRunId, result);
  if (result.checklist.length > 0 && !result.checklistReported) {
    emit("case", "case_checklist_updated", { ...context, checklist: result.checklist });
  }
  emit("case", "case_completed", {
    ...context,
    role: hook.role,
    outcome: result.outcome,
    authState: result.authState,
    summary: result.summary,
    failureReason: result.failureReason,
    keyActions: result.keyActions,
    checklist: result.checklist,
    resultPath,
    walkMs: takeWalkMs(caseRunId),
    ...(journeyCaseId ? { journeyCaseId } : {}),
  });
  if (result.outcome !== "passed" && hook.role.startsWith("after_")) {
    emit("case", "hook_attention_required", {
      ...context,
      role: hook.role,
      title: hook.title,
      outcome: result.outcome,
      message: `Teardown "${hook.title}" ${result.outcome}${result.failureReason ? `: ${result.failureReason}` : "."}`,
    });
  }
  return result;
}

/**
 * Hooks in order, each tallied. Any non-passed hook stops the sequence.
 * `journeyCaseId` names the Journey they surround, null for the run's own.
 */
export async function runHooks(suite, hooks, statePath, tally, journeyCaseId = null) {
  for (const hook of hooks) {
    const walk = tally.filter((entry) => entry.caseId === hook.id).length + 1;
    const result = await runHook(suite, hook, statePath, walk, journeyCaseId);
    tally.push({ caseRunId: hookWalkId(hook, walk), caseId: hook.id, attempt: hook.attempt, outcome: result.outcome });
    if (result.outcome === "passed") continue;
    return { hook, result, caseRunId: hookWalkId(hook, walk) };
  }
  return null;
}

/**
 * Before a failure is reproduced, the Journey's teardown then setup walk again
 * so the re-run starts clean: the first hook that did not pass, if any.
 */
export async function resetAround(suite, around, statePath, tally) {
  return await runHooks(suite, around.after, statePath, tally, around.journeyCaseId)
    ?? await runHooks(suite, around.before, statePath, tally, around.journeyCaseId);
}

/** A Journey a setup kept from walking: blocked, every checkpoint not_run, the setup named. */
export function setupBlockedResult(setup, testCase) {
  const { hook, result } = setup;
  return {
    outcome: "blocked",
    authState: "unknown",
    summary: `Setup "${hook.title}" did not pass, so this Journey was not walked.`,
    failureReason: `Setup "${hook.title}" ${result.outcome}${result.failureReason ? `: ${result.failureReason}` : "."}`,
    keyActions: [],
    checklist: checklistFromCheckpoints(testCase.checkpoints).map((item) => ({
      ...item,
      status: "not_run",
      reason: null,
    })),
  };
}

/** A blocked Journey reported without a browser: started, written, completed. */
export async function reportBlockedJourney(testCase, blocked) {
  const context = { caseRunId: testCase.id, caseId: testCase.id, attempt: testCase.attempt };
  emit("case", "case_started", { ...context, title: testCase.title, role: testCase.role });
  const result = sanitizeCaseResultCopy({ ...blocked, trust: { reproducedRuns: 1, codeEvidence: null } }, context);
  const resultPath = await writeCaseResult(testCase.id, result);
  emit("case", "case_completed", {
    ...context,
    outcome: result.outcome,
    authState: result.authState,
    summary: result.summary,
    failureReason: result.failureReason,
    keyActions: result.keyActions,
    checklist: result.checklist,
    resultPath,
  });
  return { ...context, outcome: result.outcome };
}

/** The hook tally of the suite summary, every outcome present even at zero. */
export function summarizeHooks(tally) {
  return Object.fromEntries([...HOOK_OUTCOMES].map((outcome) => [
    outcome,
    tally.filter((entry) => entry.outcome === outcome).length,
  ]));
}
