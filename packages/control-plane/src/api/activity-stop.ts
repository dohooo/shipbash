/**
 * The owner's Stop, as the stop route and a chat surface's Stop button both
 * deliver it. A Discovery or a conversation with a leg at work wraps up: the
 * leg keeps what it found and delivers it (store/activity-wrap-up.ts), and a
 * repeated Stop answers the same. Any other walk, and one of those with no
 * leg to tell (queued, waiting for a sign-in, just woken), is canceled.
 */
import { activityKnowledgeSurface } from "@shipbash/contracts/runtime/discovery-surface.mjs";

import type { ActivityResultRecord, ActivitySummary, TenantActor } from "../types.ts";
import type { ApiOptions } from "./options.ts";
import { terminalActivityStatuses } from "./views.ts";

type ActivityScope = { teamId: string; projectId: string; activityId: string };

/** What a cancel needs. */
export interface CancelDependencies {
  store: Pick<ApiOptions["store"], "cancelActivity">;
  /** Ends the sign-in a walk waits on; absent where no sign-in can be under way. */
  auth?: ApiOptions["auth"];
  /** Shows the cancel where the walk is listed: a conversation thread's to-do list. */
  workProgress?: ApiOptions["workProgress"];
}

/** What a Stop needs: a cancel's, and the wrap-up it asks of a leg at work. */
export interface StopDependencies extends CancelDependencies {
  store: Pick<ApiOptions["store"], "requestActivityWrapUp" | "cancelActivity">;
}

/**
 * Cancels the Activity, first ending the sign-in it waits on; an ended one
 * answers with its result. A canceled walk may have no worker left to show
 * its end, so it is shown here.
 */
export async function cancelWalk(
  deps: CancelDependencies,
  actor: TenantActor,
  scope: ActivityScope,
  status: string,
): Promise<ActivityResultRecord> {
  if (status === "waiting_for_auth" && deps.auth) {
    await deps.auth.cancel({
      actor, teamId: scope.teamId, projectId: scope.projectId, targetKind: "activity", targetId: scope.activityId,
    });
  }
  const result = await deps.store.cancelActivity(actor, scope.teamId, scope.projectId, scope.activityId);
  await deps.workProgress?.settle({ activityId: scope.activityId });
  return result;
}

/** How the Stop went, or null when the walk had already ended. */
export async function stopWalk(
  deps: StopDependencies,
  actor: TenantActor,
  scope: ActivityScope,
  activity: { status: ActivitySummary["status"]; kind: string; wrapUpRequested: boolean },
): Promise<"wrapping_up" | "canceled" | null> {
  if (terminalActivityStatuses.has(activity.status)) return null;
  const legAtWork = activity.status === "running" || activity.status === "waiting_for_input";
  const wrapping = activityKnowledgeSurface(activity.kind).interacts && legAtWork && (
    activity.wrapUpRequested
    || await deps.store.requestActivityWrapUp(actor, scope.teamId, scope.projectId, scope.activityId)
  );
  if (wrapping) return "wrapping_up";
  // A walk that ended while the Stop was on its way is not reported canceled.
  return (await cancelWalk(deps, actor, scope, activity.status)).kind === "canceled" ? "canceled" : null;
}
