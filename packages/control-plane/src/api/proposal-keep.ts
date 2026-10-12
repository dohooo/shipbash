/**
 * Keeping a walk's drafts, as the proposal route delivers it (a
 * conversation's keep_drafts takes the same keep under its turn's lease,
 * store/draft-keep-for-job.ts): the ones the reader kept land as the walk
 * delivered them (the store decides which, on the locked proposal), then
 * what landed is verified. The keep stands whether or not the verification
 * starts; a run under way that walks other Journeys refuses it, and the same
 * keep repeated once that run ends starts it.
 */
import type { DraftsKept } from "../store/draft-keep.ts";
import { VerificationInProgressError } from "../store/proposal-conflict.ts";
import { RunQuotaExceededError } from "../store/run-quota.ts";
import type { RunDispatchResult, TenantActor } from "../types.ts";
import { dispatchIdentity } from "../dispatch-identity.ts";
import { safeStoreError } from "./error-mapping.ts";
import { ApiError } from "./http.ts";
import type { ApiOptions } from "./options.ts";
import { assertProjectAcceptsRuns } from "./route-support.ts";

/** Why the verification of kept drafts did not start, in the envelope's terms; the run it waits on, if any. */
export type RunRefusal = { error: string; message: string; runId?: string };

export interface KeptDrafts {
  kept: DraftsKept;
  /** The verification of what landed; null when it did not start, or a run walks none of it. */
  run: RunDispatchResult | null;
  refusal: RunRefusal | null;
}

export interface KeepDependencies {
  store: Pick<ApiOptions["store"], "keepDrafts" | "verifyKeptDrafts">;
  onWorkAvailable?: ApiOptions["onWorkAvailable"];
}

export type KeepScope = { teamId: string; projectId: string; project: Parameters<typeof assertProjectAcceptsRuns>[0] };

function runRefusal(error: unknown): RunRefusal {
  if (error instanceof VerificationInProgressError) return { error: error.code, message: error.message, runId: error.runId };
  if (error instanceof RunQuotaExceededError) return { error: error.code, message: error.message };
  const known = error instanceof ApiError ? error : safeStoreError(error);
  if (known) return { error: known.code, message: known.message };
  console.error("[api] kept drafts' verification did not start:", error);
  return { error: "VERIFICATION_NOT_STARTED", message: "The verification did not start. Run the journeys from the Journeys page." };
}

async function verifyKept(
  deps: KeepDependencies,
  actor: TenantActor,
  scope: KeepScope,
  proposalId: string,
): Promise<Pick<KeptDrafts, "run" | "refusal">> {
  try {
    assertProjectAcceptsRuns(scope.project);
    const run = await deps.store.verifyKeptDrafts(
      actor, scope.teamId, scope.projectId, proposalId,
      dispatchIdentity(scope.teamId, scope.projectId, "keep-drafts", proposalId),
    );
    if (run) await deps.onWorkAvailable?.();
    return { run, refusal: null };
  } catch (error) {
    return { run: null, refusal: runRefusal(error) };
  }
}

/** Keeps as `actor`, then verifies what landed; a keep the store refuses throws. */
export async function keepDraftsAndVerify(
  deps: KeepDependencies,
  actor: TenantActor,
  scope: KeepScope,
  proposalId: string,
  decision: { expectedUpdatedAt: string; keep: string[] | null },
): Promise<KeptDrafts> {
  const kept = await deps.store.keepDrafts(actor, scope.teamId, scope.projectId, proposalId, decision);
  const verified = kept.outcome === "applied"
    ? await verifyKept(deps, actor, scope, proposalId)
    : { run: null, refusal: null };
  return { kept, ...verified };
}
