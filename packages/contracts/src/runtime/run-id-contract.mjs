/**
 * How a Suite names one run's data. A Case is written once and walked on
 * every run, so what a run creates is named with the placeholder where the
 * run id goes — enter "{run id}-users" — and the Suite keeps it that way.
 * A run reads each Case with the placeholder replaced by its family's run id
 * (a case retry names the root's, so it finds what the root left) before the
 * walk starts: in the steps it types, the checkpoints it is judged on and
 * the preconditions it relies on. Both sides that hold the text resolve it
 * here — the runner when it reads the suite (suite-contract.mjs validateSuite)
 * and the control plane when it anchors a Case Run's checklist
 * (case-runs-for-job.ts) — so the stored, reported and delivered checklists
 * carry one goal text.
 *
 * Without the placeholder, "enter the run id followed by
 * -users" gives Jev, which types only quoted values, nothing to type. A
 * checkpoint that kept the placeholder would be judged against a page that
 * can never show it, and could pass while this run's project is still listed.
 */
export const RUN_ID_PLACEHOLDER = "{run id}";

/** The text with every placeholder replaced by the run's id. */
export function resolveRunId(text, runId) {
  return text.replaceAll(RUN_ID_PLACEHOLDER, runId);
}

/** The Case as a run walks it: steps, checkpoint goals and preconditions resolved. */
export function caseForRun(testCase, runId) {
  return {
    ...testCase,
    steps: testCase.steps.map((step) => ({ ...step, instruction: resolveRunId(step.instruction, runId) })),
    checkpoints: testCase.checkpoints.map((checkpoint) => ({ ...checkpoint, goal: resolveRunId(checkpoint.goal, runId) })),
    preconditions: testCase.preconditions.map((precondition) => resolveRunId(precondition, runId)),
  };
}
