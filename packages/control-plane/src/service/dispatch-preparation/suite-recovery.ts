/**
 * Salvage for a Suite run whose Runner container died after it had already
 * written Case results.
 *
 * Recovery is all-or-nothing: every Case in the snapshot must have a result
 * whose checklist still matches the one the run reported, or the Suite re-runs
 * normally. Only once every Case has been accepted does the run record its
 * verdicts, retain the evidence and release the interrupted runtime directory.
 */
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { retainSuiteEvidence } from "../../evidence-retention/index.ts";
import { findOrphanedSuiteResults, recoveredChecklistCompatible } from "../../suite-run-recovery.ts";
import type { SuitePreparation, SuitePreparationContext } from "../dispatch-preparation.ts";
import type { SuiteCaseRunReference } from "../../dispatch-worker-types.ts";
import { localJobPortFor } from "../local-job-port.ts";

export function createRecoverSuite(
  context: SuitePreparationContext,
): SuitePreparation["recoverSuite"] {
  const { runtimeTemporaryDirectory, taskAuth } = context;
  const tenantStore = context.jobApi.store;
  // Captured once: a later swap on the lane object must not change which
  // implementation a prepared run finalizes through.
  const { cleanupRuntimeDirectory } = taskAuth;

  return async (input, capability) => {
    let recovered: Awaited<ReturnType<typeof findOrphanedSuiteResults>> = null;
    try {
      recovered = await findOrphanedSuiteResults({
        temporaryParent: resolve(runtimeTemporaryDirectory ?? tmpdir()),
        suiteRunId: input.suiteRunId,
        caseIds: input.cases.map((suiteCase) => suiteCase.id),
      });
    } catch {
      recovered = null;
    }
    if (!recovered) return false;
    const recoverable: Array<{
      snapshotCaseId: string;
      caseRunId: string;
      result: NonNullable<ReturnType<NonNullable<typeof recovered>["results"]["get"]>>;
    }> = [];
    for (const suiteCase of input.cases) {
      const result = recovered.results.get(suiteCase.id);
      if (!result) return false;
      const caseRun = await tenantStore.jobs.startCaseRunForJob(capability, suiteCase.id);
      if (!recoveredChecklistCompatible(caseRun.checklist, result.checklist)) {
        // The interrupted execution drifted from the reported checklist;
        // a normal re-run is the only path to a trustworthy verdict.
        return false;
      }
      recoverable.push({ snapshotCaseId: suiteCase.id, caseRunId: caseRun.id, result });
    }
    const caseRuns: SuiteCaseRunReference[] = [];
    for (const { snapshotCaseId, caseRunId, result } of recoverable) {
      await tenantStore.jobs.updateCaseTrustForJob(capability, caseRunId, result.trust);
      await tenantStore.jobs.completeCaseRunForJob(capability, caseRunId, {
        verdict: result.verdict,
        summary: result.summary,
        failureReason: result.failureReason,
        checklist: result.checklist,
      });
      await tenantStore.jobs.appendRunEventForJob(capability, {
        caseRunId,
        type: "case_results_recovered",
        level: "success",
        message: "Case results were recovered from an interrupted Runner execution.",
        data: { outcome: result.verdict },
      });
      // A recovered Journey wrote under its snapshot Case id.
      caseRuns.push({ snapshotCaseId, caseRunId, directory: snapshotCaseId });
    }
    await retainSuiteEvidence(localJobPortFor(context.jobApi, capability, input), {
      outputDirectory: recovered.outputDirectory,
      caseRuns,
    });
    await cleanupRuntimeDirectory(
      { outputDirectory: recovered.outputDirectory },
      "shipbash-runner-",
    );
    return true;
  };
}
