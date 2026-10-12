/**
 * The host's half of the sign-in a task injected, shared by the local lane
 * and the hosted one, and judged against one base: the version the task
 * injected. A task whose runner verified a sign-in keeps it — whichever way
 * its lane stores the bytes — and a save that fails marks the profile failed
 * so the owner reads why; a task that stopped on a sign-in wall expires the
 * session it ran with. Neither touches a profile that has moved past that
 * version.
 */
import { AUTH_PROFILE_SAVE_FAILED_REASON } from "./store/job-auth-profiles.ts";
import type { TenantStore } from "./store/tenant-store.ts";
import type { TargetAuthPromotion } from "./store/target-auth-state.ts";
import type { DispatchJobLeaseCapability } from "./types.ts";

export type SignInPromotion = "promoted" | "stale";

type Jobs = TenantStore["jobs"];

/**
 * The writes a task's sign-in makes under its lease, as either lane's store
 * takes them: the local lane's tenant store, or a Sandbox's worker store and
 * job API.
 */
export interface SignInWrites {
  appendRunEventForJob(capability: DispatchJobLeaseCapability, event: Parameters<Jobs["appendRunEventForJob"]>[1]): Promise<unknown>;
  appendActivityEventForJob(capability: DispatchJobLeaseCapability, event: Parameters<Jobs["appendActivityEventForJob"]>[1]): Promise<unknown>;
  markTargetAuthProfileExpiredForJob(capability: DispatchJobLeaseCapability, target: TargetAuthPromotion): Promise<boolean>;
  markTargetAuthProfileFailedForJob(
    capability: DispatchJobLeaseCapability,
    input: Parameters<Jobs["markTargetAuthProfileFailedForJob"]>[1],
  ): Promise<unknown>;
}

/** Where a task says what became of the sign-in its runner verified. */
export type SignInAnnouncement = (promotion: SignInPromotion) => Promise<unknown>;

/** A Suite run says it on its run events. */
export function announceToRun(
  jobs: Pick<SignInWrites, "appendRunEventForJob">,
  capability: DispatchJobLeaseCapability,
): SignInAnnouncement {
  return (promotion) => jobs.appendRunEventForJob(capability, {
    type: promotion === "promoted" ? "auth_profile_promoted" : "auth_profile_promotion_skipped",
    level: promotion === "promoted" ? "success" : "warning",
    message: promotion === "promoted"
      ? "Verified authentication state retained for future runs."
      : "A newer verified authentication state was retained; this stale run did not overwrite it.",
    data: { outcome: promotion },
  });
}

/** An Activity leg says it on the Activity's timeline. */
export function announceToActivity(
  jobs: Pick<SignInWrites, "appendActivityEventForJob">,
  capability: DispatchJobLeaseCapability,
): SignInAnnouncement {
  return (promotion) => jobs.appendActivityEventForJob(capability, {
    kind: promotion === "promoted" ? "evidence" : "warning",
    label: promotion === "promoted" ? "Verified authentication retained" : "Newer authentication state retained",
    safeData: { outcome: promotion },
  });
}

/**
 * Keeps the sign-in a task's runner verified, through the lane's own save,
 * over the version the task injected; a save that fails marks the profile
 * failed before the fault surfaces.
 */
export async function keepVerifiedSignIn(input: {
  jobs: Pick<SignInWrites, "markTargetAuthProfileFailedForJob">;
  capability: DispatchJobLeaseCapability;
  target: TargetAuthPromotion;
  save: () => Promise<SignInPromotion>;
  announce: SignInAnnouncement;
}): Promise<void> {
  const { jobs, capability, target } = input;
  let promotion: SignInPromotion;
  try {
    promotion = await input.save();
  } catch (error) {
    await jobs.markTargetAuthProfileFailedForJob(capability, {
      ...target,
      reason: AUTH_PROFILE_SAVE_FAILED_REASON,
    }).catch(() => undefined);
    throw error;
  }
  await input.announce(promotion);
}

/**
 * The session a task injected met a sign-in wall: it is dead, and the
 * profile says so while it still holds that version. Never throws — a task
 * parking on the wall must park whether or not the profile could be marked.
 */
export async function expireInjectedSignIn(
  jobs: Pick<SignInWrites, "markTargetAuthProfileExpiredForJob">,
  capability: DispatchJobLeaseCapability,
  target: TargetAuthPromotion,
): Promise<boolean> {
  return jobs.markTargetAuthProfileExpiredForJob(capability, target).catch(() => false);
}

/** An Activity leg's expiry, and the line its timeline carries for it. */
export async function expireLegSignIn(
  jobs: Pick<SignInWrites, "markTargetAuthProfileExpiredForJob" | "appendActivityEventForJob">,
  capability: DispatchJobLeaseCapability,
  target: TargetAuthPromotion,
): Promise<void> {
  if (!(await expireInjectedSignIn(jobs, capability, target))) return;
  await jobs.appendActivityEventForJob(capability, {
    kind: "warning",
    label: "Saved sign-in expired",
    safeData: { event: "sign_in_state_expired", outcome: "expired" },
  }).catch(() => undefined);
}
