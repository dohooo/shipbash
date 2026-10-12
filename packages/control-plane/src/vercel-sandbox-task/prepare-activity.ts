import { rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { type LegOpening, legControlSeed, openActivityLeg } from "../agent-data/opening.ts";
import type { PreparedActivityRuntime } from "../dispatch-worker-types.ts";
import { retainActivityEvidence } from "../evidence-retention/index.ts";
import { isRecord } from "../is-record.ts";
import { checkoutActivityRepository, runtimeRepository } from "../job-repository.ts";
import type { SignInOpening } from "../job-api/methods/preparation.ts";
import { type ActivityDisposeResult, legEndingPromotable } from "../service/dispatch-activity-auth-dispose.ts";
import { announceToActivity, expireLegSignIn } from "../task-sign-in.ts";
import type {
  ActivityExecutionInput,
  DispatchJobLeaseCapability,
} from "../types.ts";
import type { SandboxTaskContext } from "./context.ts";
import {
  cleanupRuntimeOutput,
  projectHash,
  sandboxTaskApi,
  taskSignIn,
} from "./preparation.ts";

/**
 * The Suite a generate-cases Activity was pointed at. Null both when the
 * Activity is another kind and when the protected input carries an explicit
 * null; anything else unreadable is a refusal, never a silent null.
 */
function targetSuiteId(input: ActivityExecutionInput): string | null {
  if (input.activity.kind !== "generate_cases") return null;
  let value: unknown;
  try {
    value = JSON.parse(input.protectedInput ?? "");
  } catch {
    throw new Error("Generate-cases Activity protected input is invalid.");
  }
  if (!isRecord(value)) {
    throw new Error("Generate-cases Activity protected input is invalid.");
  }
  const target = value.targetSuiteId;
  if (target === null) return null;
  if (typeof target !== "string" || !target.trim()) {
    throw new Error("Generate-cases Activity target Suite is invalid.");
  }
  return target;
}

/**
 * A leg's sign-in, settled on the bar the local lane settles it by, against
 * the version the leg injected: a leg that parked on a sign-in wall expires
 * it, and a completed leg keeps the candidate its runner marked ready.
 */
async function settleLegSignIn(
  context: SandboxTaskContext,
  capability: DispatchJobLeaseCapability,
  result: NonNullable<ActivityDisposeResult>,
  signIn: ReturnType<typeof taskSignIn>,
): Promise<void> {
  if (result.status === "waiting_for_auth") {
    await signIn.expire(expireLegSignIn);
    return;
  }
  const ready = await stat(join(context.configuration.authDirectory, "candidate.ready")).catch(() => null);
  if (!ready?.isFile() || !legEndingPromotable(result)) return;
  await signIn.keep(announceToActivity(context.store, capability));
}

/**
 * The Activity lease. The repository is checked out before anything else, so
 * every failure after that point has to clean it up by hand. The pi session
 * directory is this Sandbox's own: nothing outlives the task, so each leg
 * starts from what the record holds, as the job API opens it. The runner
 * beside this process asks the job API itself for a saved sign-in's fields.
 */
export async function prepareActivityRuntime(
  context: SandboxTaskContext,
  input: ActivityExecutionInput,
  capability: DispatchJobLeaseCapability,
  signal: AbortSignal,
): Promise<PreparedActivityRuntime> {
  const { port, configuration, environment } = context;
  // The Project's Trusted Access header, opened by the job API as the saved
  // sign-in is; the runtime hands it to the runner once and takes it away.
  const trustedAccess = await port.trustedAccess();
  const repository = await checkoutActivityRepository(port, input, { root: configuration.repositoryCheckoutRoot, environment });
  const sessionDirectory = join(configuration.rootDirectory, "pi-session");
  const cleanup = () => Promise.allSettled([
    repository.cleanup(),
    rm(sessionDirectory, { recursive: true, force: true }),
  ]);
  let scopedTargetSuiteId: string | null;
  let signInOpening: SignInOpening | null;
  let leg: LegOpening;
  let taskApi: Awaited<ReturnType<typeof sandboxTaskApi>>;
  try {
    signInOpening = await port.signInOpen();
    scopedTargetSuiteId = targetSuiteId(input);
    leg = await openActivityLeg(port, { sessionDirectory });
    taskApi = await sandboxTaskApi(context);
    if (signal.aborted) throw new Error("Activity preparation was canceled.");
  } catch (error) {
    await cleanup();
    throw error;
  }
  const signIn = taskSignIn(context, capability, signInOpening);
  const authState = signInOpening?.state ?? null;
  return {
    input: {
      activityId: input.activity.id,
      kind: input.activity.kind,
      projectId: input.job.projectId,
      productionUrl: input.productionUrl,
      testingContext: leg.testingContext,
      boundSignIns: input.boundSignIns,
      targetSuiteId: scopedTargetSuiteId,
      promptContractVersion: input.promptContractVersion,
      repositoryCheckoutLocator: repository.directory,
      repositoryAvailable: repository.commitSha !== null,
      repositoryCommitSha: repository.commitSha,
      // The bound repository, checked out or not: the agents read it on GitHub.
      repository: runtimeRepository(input.repository),
      suites: input.suites,
      recordScreen: input.recordScreen,
    },
    options: {
      taskApi,
      authDirectory: configuration.authDirectory,
      projectHash: projectHash(input.job.projectId),
      repositoryCheckoutRoot: configuration.repositoryCheckoutRoot,
      sessionDirectory,
      ...legControlSeed(leg),
      ...(authState ? { authState } : {}),
      ...(trustedAccess ? { trustedAccess } : {}),
    },
    dispose: async (result) => {
      try {
        if (result) {
          await retainActivityEvidence(port, result);
          await settleLegSignIn(context, capability, result, signIn);
        }
      } finally {
        await Promise.allSettled([cleanup(), cleanupRuntimeOutput(result?.outputDirectory)]);
      }
    },
  };
}
