/**
 * What must exist before a Runner container may execute a Suite: the
 * run-scoped auth snapshot and the optional repository checkout, plus the
 * finalize and dispose hooks that retire them.
 *
 * The order here is the behavior. Every resource acquired before a failure or
 * a cancellation is released on the way out, and the verified auth state is
 * promoted before the run's artifacts are retained, so a save failure still
 * reaches the Profile; the artifacts are retained whichever way it went.
 */
import { openSuiteRun } from "../../agent-data/opening.ts";
import { failCaseRecording, retainCaseRecording, retainSuiteEvidence } from "../../evidence-retention/index.ts";
import { shipbashProcessEnvironmentValue } from "../../environment.ts";
import { announceToRun, expireInjectedSignIn, keepVerifiedSignIn } from "../../task-sign-in.ts";
import { recordingWalkDirectory } from "../../suite-recording-source.ts";
import type { DispatchJobLeaseCapability, SuiteExecutionInput } from "../../types.ts";
import type { SuiteCaseRunReference } from "../../dispatch-worker-types.ts";
import type { JobPort } from "../../job-api/port.ts";
import type { SuitePreparation, SuitePreparationContext } from "../dispatch-preparation.ts";
import { localJobPortFor, openLocalTaskApi } from "../local-job-port.ts";
import { ensureFreshRunnerImage } from "../runtime-glue.ts";

type TaskAuthPaths = Awaited<ReturnType<SuitePreparationContext["taskAuth"]["prepareTaskAuth"]>>;

/** The Run snapshot is immutable; a Profile that moved under it must not run. */
function assertProfileMatchesSnapshot(
  profile: { id: string; snapshotStateVersion: string | null } | null,
  input: SuiteExecutionInput,
): void {
  if (
    profile &&
    (profile.id !== input.authProfileId ||
      profile.snapshotStateVersion !== input.authProfileStateVersion)
  ) {
    throw new Error("Target Auth Profile does not match the immutable Run snapshot.");
  }
}

/**
 * The run's sign-in, settled against the version its snapshot injected: kept
 * when its runner verified one, expired when it stopped on a sign-in wall
 * with one injected. The bytes stay on this host; only the version moves.
 */
function runSignIn(
  context: SuitePreparationContext,
  input: SuiteExecutionInput,
  capability: DispatchJobLeaseCapability,
  authPaths: TaskAuthPaths,
) {
  const { jobs } = context.jobApi.store;
  const target = input.authProfileId === null
    ? null
    : { profileId: input.authProfileId, baseStateVersion: input.authProfileStateVersion };
  return {
    keep: async (): Promise<void> => {
      if (!target) throw new Error("Verified Target Auth state has no snapshot Profile reference.");
      await keepVerifiedSignIn({
        jobs,
        capability,
        target,
        save: () => context.taskAuth.promoteVerifiedAuthState({
          ...target,
          projectId: input.job.projectId,
          taskAuthDirectory: authPaths.authDirectory,
          sourceAuthDirectory: authPaths.sourceAuthDirectory,
          capability,
        }),
        announce: announceToRun(jobs, capability),
      });
    },
    expire: async (): Promise<void> => {
      if (target && authPaths.injected) await expireInjectedSignIn(jobs, capability, target);
    },
  };
}

/** Each walk's recording, kept over the run's port as the runner reports it ready, or failed. */
function caseRecordingHooks(port: JobPort) {
  let outputRoot: string | null = null;
  return {
    onOutputDirectoryReady: (directory: string) => { outputRoot = directory; },
    retainCaseRecording: async (reference: SuiteCaseRunReference) => {
      if (!outputRoot) throw new Error("Suite recording output root was not prepared.");
      const directory = await recordingWalkDirectory(outputRoot, reference);
      if (!directory) throw new Error("Browser recording walk output is unavailable.");
      await retainCaseRecording(port, reference, directory);
    },
    failCaseRecording: (reference: SuiteCaseRunReference, reason: string) => failCaseRecording(port, reference, reason),
  };
}

export function createPrepareSuite(
  context: SuitePreparationContext,
): SuitePreparation["prepareSuite"] {
  const { trackProjectHash } = context;
  const tenantStore = context.jobApi.store;
  // Captured once: a later swap on the lane object must not change which
  // implementation a prepared run finalizes through.
  const { cleanupRuntimeDirectory, prepareTaskAuth } = context.taskAuth;

  return async (input, capability, signal) => {
    // The run's job API, in process: what it opens is what a hosted run's opens.
    const port = localJobPortFor(context.jobApi, capability, input);
    const trustedAccess = await port.trustedAccess();
    const profile = await tenantStore.jobs.readTargetAuthProfileForJob(capability);
    assertProfileMatchesSnapshot(profile, input);
    const opening = await openSuiteRun(port, tenantStore.jobs, capability);
    await ensureFreshRunnerImage(shipbashProcessEnvironmentValue("DOCKER_BINARY"));
    const authPaths = await prepareTaskAuth({
      projectId: input.job.projectId,
      targetKind: "run",
      targetId: input.suiteRunId,
      baseStateVersion: input.authProfileStateVersion,
      profileStatus: profile?.status ?? "missing",
    });
    if (signal.aborted) throw new Error("Suite preparation canceled.");
    const recording = caseRecordingHooks(port);
    const signIn = runSignIn(context, input, capability, authPaths);
    const taskApi = await openLocalTaskApi(port, signal);
    return {
      testingContext: opening.testingContext,
      options: {
        taskApi: taskApi.config,
        authDirectory: authPaths.authDirectory,
        projectHash: trackProjectHash(input.job.projectId),
        onOutputDirectoryReady: recording.onOutputDirectoryReady,
        ...(trustedAccess ? { trustedAccess } : {}),
        caseOpenings: opening.earlierWalks,
        knownPages: opening.knownPages,
      },
      retainCaseRecording: recording.retainCaseRecording,
      failCaseRecording: recording.failCaseRecording,
      finalize: async (result, caseRuns, outcome) => {
        // A sign-in that could not be kept never costs the run its evidence.
        try {
          if (outcome.authStatePromoted) await signIn.keep();
        } finally {
          await retainSuiteEvidence(port, { outputDirectory: result.outputDirectory, caseRuns });
        }
      },
      onSignInWall: signIn.expire,
      async dispose(result) {
        taskApi.broker.close();
        await cleanupRuntimeDirectory(result, "shipbash-runner-").catch(() => undefined);
      },
    };
  };
}
