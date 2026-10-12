/**
 * Canceling a verification, as the cancel route and a chat surface's Stop
 * both deliver it. A run no worker had taken ends inside the cancel itself
 * (store/runs.ts), and no worker will ever say it ended, so its end is shown
 * here — a conversation thread's to-do list. A run a worker holds comes back
 * canceling and is shown by that worker once it sees the cancel.
 */
import type { SuiteRunSummary, TenantActor } from "../types.ts";
import type { ApiOptions } from "./options.ts";

export interface CancelRunDependencies {
  store: Pick<ApiOptions["store"], "requestSuiteRunCancellation">;
  workProgress?: ApiOptions["workProgress"];
}

export async function cancelVerification(
  deps: CancelRunDependencies,
  actor: TenantActor,
  scope: { teamId: string; projectId: string; runId: string },
): Promise<SuiteRunSummary> {
  const run = await deps.store.requestSuiteRunCancellation(actor, scope.teamId, scope.projectId, scope.runId);
  if (run.status === "canceled") await deps.workProgress?.settle({ suiteRunId: scope.runId });
  return run;
}
