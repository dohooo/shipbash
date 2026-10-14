// How a Journey's walk becomes a verdict: a first failure is reset and
// re-walked before it is believed, and the settled result is recorded,
// written and announced. The lane around it — setup, teardown, auth state,
// the order of the Journeys — belongs to run-suite.mjs.
import { reconcileReproduction } from "../case-verdicts.mjs";

import { sanitizeCaseResultCopy } from "./browser.mjs";
import { runCodeEvidence } from "./case-agent.mjs";
import { executeCaseAttempt } from "./case-attempt.mjs";
import { finalizeCaseBrowserRecording, writeCaseResult } from "./recording-output.mjs";
import { checkCancellation, emit, takeWalkMs } from "./state.mjs";
import { resetAround } from "./suite-hooks.mjs";

/**
 * A failure is not an alert until it happens twice: the immediate re-run is
 * the reproduction attempt, and only a confirmed failure earns the second
 * reproduced run and the code evidence that goes with it.
 */
async function reproduceFailure(options) {
  const { suite, testCase, caseRunId, attempt, validationRound, activeStatePath, anchoredChecklist } = options;
  checkCancellation();
  const originalFailure = options.result;
  emit("case", "case_reproduction_started", {
    caseRunId,
    caseId: testCase.id,
    attempt,
    message: "The first walk failed; re-running once to reproduce before raising an alert.",
  });
  const reproduction = await executeCaseAttempt(
    suite,
    testCase,
    caseRunId,
    attempt,
    validationRound + 2,
    activeStatePath,
    anchoredChecklist,
    null,
    originalFailure,
  );
  const result = reconcileReproduction(originalFailure, reproduction);
  emit("case", result.outcome === "failed" ? "case_reproduction_confirmed" : "case_reproduction_cleared", {
    caseRunId,
    caseId: testCase.id,
    attempt,
    outcome: result.outcome,
    message: result.outcome === "failed"
      ? "The failure reproduced on an immediate re-run."
      : result.outcome === "exempted"
        ? "The immediate re-run passed; the walk counts as flaky, not as a failure."
        : "The re-run could not confirm the failure; no alert raised.",
  });
  if (result.outcome !== "failed") return { result, trust: { reproducedRuns: 1, codeEvidence: null } };
  const trust = {
    reproducedRuns: 2,
    codeEvidence: await runCodeEvidence(
      suite,
      testCase,
      originalFailure,
      reproduction,
      caseRunId,
    ),
  };
  emit("case", "case_trust_updated", {
    caseRunId,
    caseId: testCase.id,
    attempt,
    reproducedRuns: trust.reproducedRuns,
    codeEvidence: trust.codeEvidence,
  });
  return { result, trust };
}

/**
 * A first failure is confirmed by a re-run that starts clean: the Journey's
 * teardown and setup walk again first, and a setup that does not pass leaves
 * the failure unconfirmed rather than reproducing it in a dirty environment.
 */
export async function confirmFailure(suite, testCase, around, lane, walk) {
  const { result, caseRunId, attempt } = walk;
  const trust = { reproducedRuns: 1, codeEvidence: null };
  if (result.outcome !== "failed") return { result, trust, resetFailed: false };
  const resetFailure = await resetAround(suite, around, lane.activeStatePath, lane.hookTally);
  if (resetFailure) {
    emit("case", "case_reproduction_skipped", {
      caseRunId, caseId: testCase.id, attempt,
      message: `Hook "${resetFailure.hook.title}" did not pass before the re-run; the failure stays unconfirmed.`,
    });
    return { result, trust, resetFailed: true };
  }
  const reproduced = await reproduceFailure({ ...walk, suite, testCase, activeStatePath: lane.activeStatePath });
  return { ...reproduced, resetFailed: false };
}

/** The Journey's close: recording, the durable result, and the events that carry it. */
export async function closeJourney(testCase, walk) {
  const { caseRunId, attempt, trust } = walk;
  await finalizeCaseBrowserRecording(caseRunId, attempt, walk.result);
  const result = sanitizeCaseResultCopy({ ...walk.result, trust }, { caseRunId, caseId: testCase.id, attempt });
  const resultPath = await writeCaseResult(caseRunId, result);
  if (result.checklist.length > 0 && !result.checklistReported) {
    emit("case", "case_checklist_updated", { caseRunId, caseId: testCase.id, attempt, checklist: result.checklist });
  }
  emit("case", "case_completed", {
    caseRunId,
    caseId: testCase.id,
    attempt,
    outcome: result.outcome,
    authState: result.authState,
    summary: result.summary,
    failureReason: result.failureReason,
    keyActions: result.keyActions,
    checklist: result.checklist,
    resultPath,
    // What the Journey's walks took, waits for a sign-in left out; a Journey
    // its setup kept from walking carries none (run-units.ts).
    walkMs: takeWalkMs(caseRunId),
  });
  return result;
}
