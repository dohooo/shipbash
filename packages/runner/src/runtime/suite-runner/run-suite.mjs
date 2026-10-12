import { existsSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  assessAuthValidationResult,
  authTakeoverBlockedResult,
  authTakeoverCanceledResult,
  unverifiedAuthCandidateResult,
} from "../case-verdicts.mjs";
import { checklistFromCheckpoints, validateSuite } from "@shipbash/contracts/runtime/suite-contract.mjs";
import { consumeTrustedAccessConfig } from "../trusted-access.mjs";
import { existingStateFile } from "../browser-state-seal.mjs";

import {
  AUTH_CANDIDATE_PATH,
  AUTH_CANDIDATE_READY_PATH,
  authTakeoverTimeoutMs,
  CONTROL_ROOT,
  INPUT_PATH,
  OUTPUT_ROOT,
  WORK_DIRECTORY,
} from "./environment.mjs";
import { registerSecret, registerTrustedAccess } from "./redaction.mjs";
import { checkCancellation, emit, setSuiteRunId } from "./state.mjs";
import { executeCaseAttempt } from "./case-attempt.mjs";
import { closeJourney, confirmFailure } from "./journey-confirmation.mjs";
import { existingAuthStatePath, waitForAuthentication } from "./auth-handshake.mjs";
import { retainSuiteSignInState } from "./sign-in-writeback.mjs";
import { consumeTaskApiConfig } from "../task-api.mjs";
import {
  hooksAround,
  planSuite,
  reportBlockedJourney,
  runHooks,
  setupBlockedResult,
  summarizeHooks,
} from "./suite-hooks.mjs";

/**
 * The first case of a run walked against a candidate the host handed over: a
 * proven candidate stays in place, an unauthenticated result hands back to
 * the saved state, and one the fresh case could not prove blocks the case.
 */
async function settlePendingCandidate({ result, caseRunId, attempt, activeStatePath }) {
  const pendingDecision = assessAuthValidationResult(result);
  await unlink(AUTH_CANDIDATE_READY_PATH).catch(() => {});
  if (pendingDecision === "promote") {
    emit("case", "auth_state_promoted", {
      caseRunId,
      attempt,
      validationRound: 0,
      path: activeStatePath,
    });
    return { result, activeStatePath };
  }
  if (pendingDecision === "handoff") return { result, activeStatePath: existingAuthStatePath() };
  if (pendingDecision === "blocked") return { result: unverifiedAuthCandidateResult(result), activeStatePath };
  return { result, activeStatePath };
}

/**
 * The human auth lane: a case that came back auth_required waits for a person
 * to sign in, then proves the captured candidate with a fresh walk. Loops
 * while the fresh walk still reports auth_required, and ends on a promoted
 * candidate, a refused one, or a takeover that timed out or was canceled.
 */
async function resolveAuthRequired(options) {
  const { suite, testCase, caseRunId, attempt } = options;
  let { result, stableChecklist, activeStatePath } = options;
  let validationRound = 0;
  let authDeadline = null;
  let takeoverTimeoutMs = null;
  while (result.outcome === "auth_required") {
    if (authDeadline === null) {
      takeoverTimeoutMs = authTakeoverTimeoutMs();
      authDeadline = Date.now() + takeoverTimeoutMs;
    }
    validationRound += 1;
    const candidatePath = await waitForAuthentication(
      caseRunId,
      attempt,
      validationRound,
      authDeadline,
      takeoverTimeoutMs,
    );
    if (candidatePath === "auth_takeover_canceled") {
      result = authTakeoverCanceledResult(stableChecklist);
      break;
    }
    if (candidatePath === null) {
      result = authTakeoverBlockedResult(takeoverTimeoutMs, stableChecklist);
      break;
    }
    emit("case", "auth_validation_started", {
      caseRunId,
      attempt,
      validationRound,
    });
    const validationResult = await executeCaseAttempt(
      suite,
      testCase,
      caseRunId,
      attempt,
      validationRound + 1,
      candidatePath,
      stableChecklist,
    );
    stableChecklist = validationResult.checklist.length > 0
      ? validationResult.checklist
      : stableChecklist;
    const validationDecision = assessAuthValidationResult(validationResult);
    if (validationDecision === "handoff") {
      result = validationResult;
      emit("case", "auth_validation_failed", {
        caseRunId,
        attempt,
        validationRound,
        message: "The fresh case remained unauthenticated; returning to the human auth lane.",
      });
      continue;
    }
    if (validationDecision === "error") {
      emit("case", "auth_validation_error", {
        caseRunId,
        attempt,
        validationRound,
        message: "The fresh validation case hit an infrastructure error; the candidate state was not promoted.",
      });
      result = validationResult;
      break;
    }
    if (validationDecision === "blocked") {
      result = unverifiedAuthCandidateResult(validationResult);
      emit("case", "auth_validation_blocked", {
        caseRunId,
        attempt,
        validationRound,
        authState: validationResult.authState,
        outcome: validationResult.outcome,
        message:
          "The fresh case did not prove an authenticated passed/failed result; the candidate state was not promoted.",
      });
      break;
    }
    activeStatePath = candidatePath;
    emit("case", "auth_state_promoted", {
      caseRunId,
      attempt,
      validationRound,
      path: activeStatePath,
    });
    result = validationResult;
  }
  return { result, validationRound, activeStatePath };
}

/**
 * The steady-state writeback step a case attempt runs before closing its
 * browser, or null: every case of a run that never took over (a takeover
 * promotes through its own lane; each case with a passed/failed verdict that
 * did not end at a login gate overwrites the candidate, so the newest wins
 * and a blocked last case loses nothing), and
 * only when the run injected a sign-in state at all — the same bar the
 * Activity lane sets, so an anonymous case that calls itself authenticated
 * cannot become the project's ready profile. A case that signed in again with
 * saved credentials hands the session it wrote to every Journey and hook
 * after it, as a promoted takeover candidate is handed on.
 */
function steadyStateWriteback(suite, lane) {
  const beforePath = lane.activeStatePath;
  if (lane.tookOver || beforePath === null) return null;
  return async (result, env, fetchedCredentials) => {
    const written = await retainSuiteSignInState({ result, env, productionUrl: suite.productionUrl, beforePath });
    if (written && fetchedCredentials) lane.activeStatePath = existingStateFile(AUTH_CANDIDATE_PATH);
  };
}

/** The suite summary's per-outcome tally, every outcome present even at zero. */
function summarizeOutcomes(results) {
  return Object.fromEntries(
    ["passed", "failed", "blocked", "error", "auth_required", "exempted"].map((outcome) => [
      outcome,
      results.filter((result) => result.outcome === outcome).length,
    ]),
  );
}

/** The run-level hook the summary names: a before_all or an after_all that did not pass. */
function hookFailureSummary(failure) {
  if (!failure) return null;
  const { hook, result, caseRunId } = failure;
  return {
    caseId: hook.id, caseRunId, role: hook.role, title: hook.title,
    outcome: result.outcome, failureReason: result.failureReason ?? null,
  };
}

/**
 * One Journey of the walk inside its setup and teardown, and the outcome it
 * reached. A hook scoped to a Journey marks that Journey alone: a setup
 * that did not pass blocks it and skips its teardown, a teardown that did not
 * pass is tallied and raised as attention, and the run walks on either way.
 * The lane carries the auth state across Journeys: the candidate a run was
 * handed, the path every attempt is walked against, and whether the run has
 * taken over.
 */
async function walkJourney(suite, plan, testCase, lane) {
  const caseRunId = testCase.id;
  const attempt = testCase.attempt;
  const around = hooksAround(plan, testCase);
  const setup = await runHooks(suite, around.before, lane.activeStatePath, lane.hookTally, around.journeyCaseId);
  emit("case", "case_started", { caseRunId, caseId: testCase.id, title: testCase.title, attempt });
  // The Checklist is anchored to the Journey checkpoints for every run; the
  // agent can only report status transitions against these fixed ids.
  const anchoredChecklist = checklistFromCheckpoints(testCase.checkpoints);
  let result = setup ? setupBlockedResult(setup, testCase) : await executeCaseAttempt(
    suite,
    testCase,
    caseRunId,
    attempt,
    1,
    lane.activeStatePath,
    anchoredChecklist,
    steadyStateWriteback(suite, lane),
  );
  const stableChecklist = result.checklist.length > 0 ? result.checklist : anchoredChecklist;
  // Only a Journey that walked can settle the candidate it was handed.
  if (lane.pendingCandidatePath && !setup) {
    const settled = await settlePendingCandidate({ result, caseRunId, attempt, activeStatePath: lane.activeStatePath });
    result = settled.result;
    lane.activeStatePath = settled.activeStatePath;
    lane.pendingCandidatePath = null;
  }
  const resolved = await resolveAuthRequired({
    suite, testCase, caseRunId, attempt, result, stableChecklist, activeStatePath: lane.activeStatePath,
  });
  lane.activeStatePath = resolved.activeStatePath;
  const validationRound = resolved.validationRound;
  if (validationRound > 0) lane.tookOver = true;
  const confirmed = await confirmFailure(suite, testCase, around, lane, {
    result: resolved.result, caseRunId, attempt, validationRound, anchoredChecklist,
  });
  const closed = await closeJourney(testCase, { ...confirmed, caseRunId, attempt });
  lane.results.push({ caseRunId, caseId: testCase.id, attempt, outcome: closed.outcome });
  // A Journey the setup blocked has nothing to tear down, and a reset that did
  // not pass already walked this teardown before the reproduction.
  if (!setup && !confirmed.resetFailed) {
    await runHooks(suite, around.after, lane.activeStatePath, lane.hookTally, around.journeyCaseId);
  }
  return closed.outcome;
}

export async function runSuite() {
  const suite = validateSuite(JSON.parse(await readFile(INPUT_PATH, "utf8")));
  setSuiteRunId(suite.suiteRunId);
  await Promise.all([
    mkdir(OUTPUT_ROOT, { recursive: true }),
    mkdir(CONTROL_ROOT, { recursive: true }),
    mkdir(join(CONTROL_ROOT, "auth"), { recursive: true }),
    mkdir(WORK_DIRECTORY, { recursive: true }),
  ]);
  await consumeTaskApiConfig({ registerSecret });
  const trustedAccess = await consumeTrustedAccessConfig(suite.productionUrl);
  registerTrustedAccess(trustedAccess);
  const pendingCandidatePath = existsSync(AUTH_CANDIDATE_READY_PATH) ? existingStateFile(AUTH_CANDIDATE_PATH) : null;
  const lane = {
    pendingCandidatePath,
    activeStatePath: pendingCandidatePath ?? existingAuthStatePath(),
    // Takeover candidates promote through their own lane.
    tookOver: pendingCandidatePath !== null,
    results: [],
    hookTally: [],
  };
  const plan = planSuite(suite.cases);
  emit("suite", "suite_started", { caseCount: suite.cases.length, journeyCount: plan.journeys.length });

  let hookFailure = await runHooks(suite, plan.beforeAll, lane.activeStatePath, lane.hookTally);
  if (hookFailure && plan.journeys[0]) {
    lane.results.push(await reportBlockedJourney(plan.journeys[0], setupBlockedResult(hookFailure, plan.journeys[0])));
  }
  if (!hookFailure) {
    for (const testCase of plan.journeys) {
      checkCancellation();
      // A harness error is the one Journey verdict that stops the run.
      const outcome = await walkJourney(suite, plan, testCase, lane);
      if (outcome === "error") break;
    }
  }
  if (!hookFailure) {
    hookFailure = await runHooks(suite, plan.afterAll, lane.activeStatePath, lane.hookTally);
  }

  emit("suite", "suite_completed", {
    counts: summarizeOutcomes(lane.results), results: lane.results, hooks: summarizeHooks(lane.hookTally),
    hookFailure: hookFailureSummary(hookFailure),
  });
}
