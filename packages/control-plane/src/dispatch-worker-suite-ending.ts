/**
 * How a Suite run ends once its runtime returns: its preparation's finalize,
 * told whether the run may keep the sign-in it verified; its teardown, told
 * whether the run parked on a sign-in wall; and the disposition the worker
 * settles the Job with.
 */
import type { DockerSuiteRunResult } from "./docker-runtime.ts";
import { outOfMemoryFailureReason, safeFailure } from "./dispatch-worker-support.ts";
import type {
  PreparedSuiteRuntime,
  RuntimeDisposition,
  SuiteCaseRunReference,
} from "./dispatch-worker-types.ts";

export interface SuiteEventState {
  waitingForAuth: boolean;
  authStatePromoted: boolean;
  caseError: string | null;
  eventFailure: string | null;
  hookFailureReason: string | null;
}

/** The runtime's teardown, then — for a run parked on a sign-in wall — the word that its injected sign-in is dead. */
export async function disposeSuite(
  prepared: PreparedSuiteRuntime,
  runtimeResult: DockerSuiteRunResult | undefined,
  parkedOnSignInWall: boolean,
): Promise<void> {
  await prepared.dispose?.(runtimeResult);
  if (parkedOnSignInWall) await prepared.onSignInWall?.();
}

/** A run that failed or was canceled keeps no sign-in it verified, on either lane. */
export function keepsVerifiedSignIn(state: SuiteEventState, result: DockerSuiteRunResult, signal: AbortSignal): boolean {
  return state.authStatePromoted && result.status === "completed" && !signal.aborted;
}

export async function finalizeSuite(
  prepared: PreparedSuiteRuntime,
  runtimeResult: DockerSuiteRunResult,
  references: readonly SuiteCaseRunReference[],
  authStatePromoted: boolean,
): Promise<string | null> {
  try {
    await prepared.finalize?.(runtimeResult, references, { authStatePromoted });
    return null;
  } catch (error) {
    return safeFailure(error);
  }
}

export function resolveSuiteDisposition(args: {
  state: SuiteEventState;
  runtimeResult: DockerSuiteRunResult | undefined;
  controller: AbortController;
  finalizationFailure: string | null;
}): RuntimeDisposition {
  const { state, runtimeResult, controller, finalizationFailure } = args;
  if (state.waitingForAuth) return { kind: "waiting_for_auth" };
  if (state.eventFailure) return {
    kind: "failed",
    reason: state.eventFailure,
    ...(finalizationFailure ? { finalizationFailure } : {}),
  };
  if (!runtimeResult) throw new Error("Suite Runtime returned no result.");
  if (controller.signal.aborted || runtimeResult.status === "canceled") {
    return {
      kind: "canceled",
      reason: "Suite execution was canceled.",
      ...(finalizationFailure ? { finalizationFailure } : {}),
    };
  }
  if (state.caseError) return {
    kind: "failed",
    reason: state.caseError,
    ...(finalizationFailure ? { finalizationFailure } : {}),
  };
  if (runtimeResult.status !== "completed") {
    return {
      kind: "failed",
      reason: outOfMemoryFailureReason("Suite", runtimeResult.exitCode)
        ?? `Suite Runner exited with status ${runtimeResult.status}.`,
      ...(finalizationFailure ? { finalizationFailure } : {}),
    };
  }
  return { kind: "completed",
    ...(state.hookFailureReason ? { hookFailureReason: state.hookFailureReason } : {}),
    ...(finalizationFailure ? { finalizationFailure } : {}) };
}
