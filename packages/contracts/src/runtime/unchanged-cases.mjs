/**
 * Unchanged Cases, resolved by id. "unchanged" means the stored definition,
 * so an unchanged Case in a change_suite Proposal is the Suite snapshot's
 * own Case — role, scope, and repeat included — never the copy that was
 * delivered (for example, eight before_each hooks handed back without a
 * role would refuse the whole round).
 */
import { checkpointStepNumber } from "./checkpoint-step.mjs";
import { isRecord } from "./contract-values.mjs";

/**
 * A Suite snapshot Case as an unchanged candidate. It carries no
 * preconditions (an empty list inherits the stored ones on apply) and needs
 * no owner confirmation.
 */
export function unchangedCandidate(suiteCase) {
  return {
    id: suiteCase.id,
    title: suiteCase.title,
    category: suiteCase.category ?? "Core product",
    steps: suiteCase.steps.map((step) => step.instruction),
    checkpoints: suiteCase.checkpoints.map((checkpoint) => ({
      goal: checkpoint.goal,
      afterStep: checkpointStepNumber(suiteCase.steps, checkpoint.afterStep),
    })),
    preconditions: [],
    whyItMatters: suiteCase.whyItMatters ?? null,
    role: suiteCase.role ?? "journey",
    scopeCaseId: suiteCase.scopeCaseId ?? null,
    scopeCandidateIndex: null,
    ownerConfirmation: "not_needed",
    repeat: suiteCase.repeat ?? "repeatable",
    enabled: suiteCase.enabled,
    archived: suiteCase.archived,
    change: "unchanged",
  };
}

/**
 * Each change_suite Proposal's unchanged Cases, replaced by the Suite's own.
 * A Case the snapshot does not hold, and every other change kind, is left
 * for the validator to judge as delivered.
 */
export function resolveUnchangedCases(proposals, suites) {
  if (!Array.isArray(proposals)) return proposals;
  const known = Array.isArray(suites) ? suites : [];
  return proposals.map((proposal) => {
    if (!isRecord(proposal) || proposal.kind !== "change_suite" || !Array.isArray(proposal.candidateDefinition)) return proposal;
    const suite = known.find((entry) => entry.id === proposal.targetSuiteId);
    if (!suite) return proposal;
    const candidateDefinition = proposal.candidateDefinition.map((entry) => {
      if (!isRecord(entry) || entry.change !== "unchanged") return entry;
      const current = suite.cases.find((suiteCase) => suiteCase.id === entry.id);
      return current ? unchangedCandidate(current) : entry;
    });
    return { ...proposal, candidateDefinition };
  });
}
