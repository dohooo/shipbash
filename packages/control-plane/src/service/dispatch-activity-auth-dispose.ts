/**
 * The sign-in settlement at an Activity leg's dispose. A leg that parked on a
 * sign-in wall expires the profile it ran with; a completed leg that left a
 * candidate ready (its own leg-end writeback, or a takeover's capture it
 * resumed on) promotes it unless it ended unauthenticated, in which case the
 * candidate is kept as unverified for the next Suite run's first case to
 * validate; a leg that failed or was canceled keeps nothing. Both are guarded
 * by the version the leg injected, so a newer session another lane promoted
 * is never expired or overwritten.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { PreparedActivityRuntime } from "../dispatch-worker-types.ts";
import { announceToActivity, expireLegSignIn, keepVerifiedSignIn } from "../task-sign-in.ts";
import type { TenantStore } from "../store/tenant-store.ts";
import type { DispatchJobLeaseCapability } from "../types.ts";
import type { TaskAuthPlumbing } from "./task-auth-plumbing.ts";
import type { InjectedTaskState } from "./task-auth-seeding.ts";

export type TaskAuthPaths = Awaited<ReturnType<TaskAuthPlumbing["prepareTaskAuth"]>>;
export type TargetAuthProfile = Awaited<
  ReturnType<TenantStore["internal"]["ensureTargetAuthProfileInternal"]>
>;
export type ActivityDisposeResult = Parameters<NonNullable<PreparedActivityRuntime["dispose"]>>[0];

/** What settling a leg's sign-in reads of its preparation. */
export interface ActivitySignInSettlement {
  tenantStore: TenantStore;
  taskAuth: TaskAuthPlumbing;
  capability: DispatchJobLeaseCapability;
  teamId: string;
  projectId: string;
  authProfile: TargetAuthProfile;
  authPaths: TaskAuthPaths;
}

/**
 * The version this leg's ending is judged against — the one it actually
 * injected, not the profile's at the time. A task directory outlives its legs
 * and preparation re-seeds it to the profile's version, so the two agree
 * unless nothing could be seeded; a takeover's candidate is the exception,
 * since it descends from the profile's version rather than being one.
 */
function injectedBaseVersion(
  injected: InjectedTaskState | null,
  authProfile: TargetAuthProfile,
): string | null {
  if (injected === null) return null;
  return injected.source === "candidate" ? authProfile.stateVersion : injected.version;
}

/**
 * A leg that parked on a sign-in wall proved the session it ran with is dead:
 * the profile expires so the owner sees why, guarded by the version the leg
 * injected so a newer promoted session is never killed (a Suite run does the
 * same when it parks; the injected version is only known to the preparation,
 * so it runs here, at dispose). A leg that injected
 * nothing, or bytes the profile had already moved past, proves nothing about
 * the profile's current session and only says so.
 */
async function expireParkedActivityAuthProfile(
  tenantStore: TenantStore,
  capability: DispatchJobLeaseCapability,
  authProfile: TargetAuthProfile,
  result: ActivityDisposeResult,
  injected: InjectedTaskState | null,
): Promise<void> {
  if (result?.status !== "waiting_for_auth" || injected === null) return;
  const baseStateVersion = injectedBaseVersion(injected, authProfile);
  if (baseStateVersion !== authProfile.stateVersion) {
    await tenantStore.jobs
      .appendActivityEventForJob(capability, {
        kind: "evidence",
        label: "Saved sign-in left as it is: this leg ran on an older session",
        safeData: { event: "sign_in_state_stale", outcome: "stale" },
      })
      .catch(() => undefined);
    return;
  }
  await expireLegSignIn(tenantStore.jobs, capability, { profileId: authProfile.id, baseStateVersion });
}

/**
 * Whether a leg's ending lets the candidate it left ready be promoted. The
 * agent's authState only flags a leg that stopped at a sign-in wall; it never
 * proves a session alive — the pi lane reports "unknown" for every completed
 * round — and the ready marker is written only past the container's own two
 * gates (sign-in-candidate.mjs: the regression guard against the state the
 * leg loaded, then the product-page ruler), so the host has no better reading
 * than the container's and promotes on the same bar it wrote on — and only
 * on a leg that completed, as a Suite run keeps a sign-in only when it
 * completed. Both lanes read it.
 */
export function legEndingPromotable(result: ActivityDisposeResult): boolean {
  const authState = result?.result?.authState;
  return result?.status === "completed" && (authState === "authenticated" || authState === "unknown");
}

/** A leg that failed or was canceled vouches for nothing it left behind. */
function legEndedWithoutVerdict(result: ActivityDisposeResult): boolean {
  return result?.status === "failed" || result?.status === "canceled";
}

/** Expires, promotes or retains this leg's sign-in state, as the leg's ending decides. */
export async function settleActivitySignIn(
  { tenantStore, taskAuth, capability, teamId, projectId, authProfile, authPaths }: ActivitySignInSettlement,
  result: ActivityDisposeResult,
): Promise<void> {
  await expireParkedActivityAuthProfile(tenantStore, capability, authProfile, result, authPaths.injected);
  const baseStateVersion = injectedBaseVersion(authPaths.injected, authProfile);
  const hasHumanCandidate =
    (await stat(join(authPaths.authDirectory, "candidate.ready")).catch(() => null))?.isFile() ===
    true;
  if (hasHumanCandidate && legEndingPromotable(result)) {
    const target = { profileId: authProfile.id, baseStateVersion };
    await keepVerifiedSignIn({
      jobs: tenantStore.jobs,
      capability,
      target,
      save: () => taskAuth.promoteVerifiedAuthState({
        ...target,
        projectId,
        taskAuthDirectory: authPaths.authDirectory,
        sourceAuthDirectory: authPaths.sourceAuthDirectory,
        capability,
      }),
      announce: announceToActivity(tenantStore.jobs, capability),
    });
    // Promoted or lost the race, the candidate is settled: left behind, the
    // next leg would load and re-offer bytes the profile has moved past.
    await taskAuth.clearTaskCandidate(authPaths.authDirectory);
  } else if (legEndedWithoutVerdict(result)) {
    // Nothing it left may reach the profile or the next leg.
    await taskAuth.clearTaskCandidate(authPaths.authDirectory);
  } else {
    await taskAuth.retainUnverifiedAuthCandidate({
      teamId,
      projectId,
      profileId: authProfile.id,
      baseStateVersion,
      taskAuthDirectory: authPaths.authDirectory,
      sourceAuthDirectory: authPaths.sourceAuthDirectory,
    });
  }
}
