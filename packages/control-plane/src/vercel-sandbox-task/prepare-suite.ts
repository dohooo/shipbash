import { openSuiteRun } from "../agent-data/opening.ts";
import type { PreparedSuiteRuntime } from "../dispatch-worker-types.ts";
import { failCaseRecording, retainCaseRecording, retainSuiteEvidence } from "../evidence-retention/index.ts";
import type { SignInOpening } from "../job-api/methods/preparation.ts";
import type { JobPort } from "../job-api/port.ts";
import { recordingWalkDirectory } from "../suite-recording-source.ts";
import { announceToRun, expireInjectedSignIn } from "../task-sign-in.ts";
import type {
  DispatchJobLeaseCapability,
  SuiteExecutionInput,
} from "../types.ts";
import type { SandboxTaskContext } from "./context.ts";
import {
  cleanupRuntimeOutput,
  projectHash,
  sandboxTaskApi,
  taskSignIn,
} from "./preparation.ts";

/**
 * The sign-in this run injects: the Project's saved state, on the profile the
 * Run's snapshot names, refused when that profile is no longer the Run's.
 */
async function injectedRunSignIn(port: JobPort, input: SuiteExecutionInput): Promise<SignInOpening | null> {
  const opening = await port.signInOpen();
  if ((opening?.profileId ?? null) !== input.authProfileId) {
    throw new Error("Target Auth Profile does not match the immutable Run snapshot.");
  }
  return opening;
}

/**
 * The Suite lease: the Project's Trusted Access header, the refusal that must
 * fire before any work (an Auth Profile that is no longer the Run snapshot's),
 * the accounts the runner beside this process may ask the job API about, and the
 * two hooks the worker calls once the run ends: finalize keeps the sign-in the
 * run verified before it retains the run's evidence, as the local lane does.
 * Nothing is checked out: the run's agents read the repository on GitHub.
 */
export async function prepareSuiteRuntime(
  context: SandboxTaskContext,
  input: SuiteExecutionInput,
  capability: DispatchJobLeaseCapability,
  signal: AbortSignal,
): Promise<PreparedSuiteRuntime> {
  const { port, configuration } = context;
  const trustedAccess = await port.trustedAccess();
  const signInOpening = await injectedRunSignIn(port, input);
  const signIn = taskSignIn(context, capability, signInOpening);
  const opening = await openSuiteRun(port, context.store, capability);
  if (signal.aborted) throw new Error("Suite preparation was canceled.");
  const taskApi = await sandboxTaskApi(context);
  let outputRoot: string | null = null;
  return {
    testingContext: opening.testingContext,
    ...(signInOpening?.state ? { authState: signInOpening.state } : {}),
    options: {
      taskApi,
      authDirectory: configuration.authDirectory,
      projectHash: projectHash(input.job.projectId),
      caseOpenings: opening.earlierWalks,
      onOutputDirectoryReady: (directory) => { outputRoot = directory; },
      ...(trustedAccess ? { trustedAccess } : {}),
    },
    retainCaseRecording: async (reference) => {
      if (!outputRoot) throw new Error("Suite recording output root was not prepared.");
      const directory = await recordingWalkDirectory(outputRoot, reference);
      if (!directory) throw new Error("Browser recording walk output is unavailable.");
      await retainCaseRecording(port, reference, directory);
    },
    failCaseRecording: (reference, reason) => failCaseRecording(port, reference, reason),
    finalize: async (result, caseRuns, outcome) => {
      // A sign-in that could not be kept never costs the run its evidence,
      // which dies with this Sandbox unless it is persisted now.
      try {
        if (outcome.authStatePromoted) await signIn.keep(announceToRun(context.store, capability));
      } finally {
        await retainSuiteEvidence(port, { outputDirectory: result.outputDirectory, caseRuns });
      }
    },
    onSignInWall: () => signIn.expire(expireInjectedSignIn),
    dispose: async (result) => {
      await cleanupRuntimeOutput(result?.outputDirectory).catch(() => undefined);
    },
  };
}
