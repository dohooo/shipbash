/**
 * A message to an Activity, whatever its state. A live leg folds it off its
 * record within a heartbeat; a DELIVERED discovery or conversation is asleep,
 * so the same message also rings the wake bell — the SAME Activity re-queues
 * and its next leg resumes the same pi session with this message folded in. An Activity of
 * ANY kind PARKED on a login gate (waiting_for_auth) resumes the same way a
 * finished sign-in does: the message is the owner's cue to try again, and the
 * fresh round re-decides whether it still needs a human. Other terminal states
 * stay unreachable (retry is their door). The steer route delivers through
 * here, and the activity detail says whether a message would reach it.
 */
import { activityKnowledgeSurface } from "@shipbash/contracts/runtime/discovery-surface.mjs";

import type { RouteContext } from "./route-support.ts";
import { terminalActivityStatuses } from "./views.ts";

type SteeredActivity = { status: Parameters<typeof terminalActivityStatuses.has>[0]; kind: string };

/**
 * A delivered Activity of a kind that converses (Discovery, a conversation)
 * sleeps with its list and its session. One held for attention — closed by
 * its time budget — still holds both: the owner's message wakes it the same
 * way.
 */
function wakeable(activity: SteeredActivity): boolean {
  return (activity.status === "completed" || activity.status === "needs_attention")
    && activityKnowledgeSurface(activity.kind).interacts;
}

/** Whether a message can still reach the Activity: a live one, or a delivered one that converses. */
export function takesSteer(activity: SteeredActivity): boolean {
  return !terminalActivityStatuses.has(activity.status) || wakeable(activity);
}

/**
 * Delivers a message to an Activity that takes it (takesSteer). The store
 * records it and, in the same transaction, wakes or resumes an Activity it
 * finds asleep (store/activity-interaction.ts), so the work bell rings only
 * when this message was the one that woke it.
 */
export async function deliverSteer(
  { actor, options }: RouteContext,
  scope: { teamId: string; projectId: string; activityId: string },
  input: { message: string; clientKey: string },
): Promise<void> {
  const woke = await options.store.steerActivity(actor, scope.teamId, scope.projectId, scope.activityId, input);
  if (woke) await options.onWorkAvailable?.();
}
