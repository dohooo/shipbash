/**
 * Activity dispatch preparation.
 *
 * An Activity container gets everything a suite gets — auth snapshot and
 * trusted access — plus a repository checkout (or an empty
 * url-only scratch directory), the leg's opening, and the inline session
 * registration that lets a takeover find the running container. dispose() is
 * where evidence retention and auth candidate promotion happen, because only
 * then is the runtime's verdict known.
 */
import { resolve } from "node:path";

import type { TaskApiConfig } from "@shipbash/contracts/runtime/job-api.mjs";
import type { TaskBroker } from "@shipbash/runner/runtime/task-broker.mjs";

import { type LegOpening, legControlSeed, openActivityLeg } from "../agent-data/opening.ts";
import { retainActivityEvidence } from "../evidence-retention/index.ts";
import { shipbashProcessEnvironmentValue } from "../environment.ts";
import { isRecord } from "../is-record.ts";
import type { JobApiResources } from "../job-api/define.ts";
import type { JobPort } from "../job-api/port.ts";
import { type ActivityCheckout, checkoutActivityRepository, runtimeRepository } from "../job-repository.ts";
import type { PreparedActivityRuntime } from "../dispatch-worker-types.ts";
import type { ActivityExecutionInput, DispatchJobLeaseCapability } from "../types.ts";
import {
  type ActivityDisposeResult,
  settleActivitySignIn,
  type TargetAuthProfile,
  type TaskAuthPaths,
} from "./dispatch-activity-auth-dispose.ts";
import { localJobPortFor, openLocalTaskApi } from "./local-job-port.ts";
import { ensureFreshRunnerImage } from "./runtime-glue.ts";
import type { InlineActivitySessionRegistry } from "./runtime-session-registry.ts";
import type { TaskAuthPlumbing } from "./task-auth-plumbing.ts";

/** What activity preparation borrows from the service closure. */
export interface ActivityPreparationContext {
  /** The store and what the leg's job port serves from: its opening, its checkout token, and the task API the runner asks. */
  jobApi: JobApiResources;
  repositoryCheckoutRoot: string;
  taskAuth: TaskAuthPlumbing;
  inlineActivityAuthSessions: InlineActivitySessionRegistry;
  trackProjectHash(projectId: string): string;
}

/** Everything the returned runtime object and its dispose() read from prep. */
interface PreparedActivityRuntimeArgs {
  context: ActivityPreparationContext;
  input: ActivityExecutionInput;
  capability: DispatchJobLeaseCapability;
  trustedAccess: Awaited<ReturnType<JobPort["trustedAccess"]>>;
  authProfile: TargetAuthProfile;
  authPaths: TaskAuthPaths;
  checkout: ActivityCheckout;
  port: JobPort;
  taskBroker: TaskBroker;
  taskApi: TaskApiConfig;
  opening: LegOpening;
  sessionDirectory: string;
  targetSuiteId: string | null;
}

/** Reads `targetSuiteId` from a generate_cases Activity's protected input. */
export function parseGenerateCasesTargetSuiteId(
  protectedInput: string | null | undefined,
): string | null {
  const parsed: unknown = JSON.parse(protectedInput ?? "");
  // A JSON `null` is invalid input and throws. An object exposes
  // `targetSuiteId`; any other value carries no string id.
  if (parsed === null) throw new TypeError("Activity protected input is null.");
  const targetSuiteId = isRecord(parsed) ? parsed.targetSuiteId : undefined;
  return typeof targetSuiteId === "string" ? targetSuiteId : null;
}

export async function prepareActivityRuntime(
  context: ActivityPreparationContext,
  input: ActivityExecutionInput,
  capability: DispatchJobLeaseCapability,
  signal: AbortSignal,
): Promise<PreparedActivityRuntime> {
  const { repositoryCheckoutRoot } = context;
  const tenantStore = context.jobApi.store;
  await ensureFreshRunnerImage(shipbashProcessEnvironmentValue("DOCKER_BINARY"));
  // The leg's job API, in process: what it opens is what a hosted leg's opens.
  const port = localJobPortFor(context.jobApi, capability, input);
  const trustedAccess = await port.trustedAccess();
  const authProfile = await tenantStore.internal.ensureTargetAuthProfileInternal(
    input.job.teamId,
    input.job.projectId,
    input.productionUrl,
  );
  const authPaths = await context.taskAuth.prepareTaskAuth({
    projectId: input.job.projectId,
    targetKind: "activity",
    targetId: input.activity.id,
    baseStateVersion: authProfile.stateVersion,
    profileStatus: authProfile.status,
  });
  let targetSuiteId: string | null = null;
  if (input.activity.kind === "generate_cases") {
    try {
      targetSuiteId = parseGenerateCasesTargetSuiteId(input.protectedInput);
    } catch {
      throw new Error("Activity protected input is invalid.");
    }
  }
  const checkout = await checkoutActivityRepository(port, input, { root: repositoryCheckoutRoot, environment: process.env });
  if (signal.aborted) {
    await checkout.cleanup().catch(() => undefined);
    throw new Error("Activity preparation canceled.");
  }
  const sessionDirectory = resolve(authPaths.authDirectory, "..", "..", "pi-session");
  const opening = await openActivityLeg(port, { sessionDirectory });
  const taskApi = await openLocalTaskApi(port, signal);
  return buildPreparedActivityRuntime({
    port,
    taskBroker: taskApi.broker,
    taskApi: taskApi.config,
    opening,
    sessionDirectory,
    context,
    input,
    capability,
    trustedAccess,
    authProfile,
    authPaths,
    checkout,
    targetSuiteId,
  });
}

function buildPreparedActivityRuntime(args: PreparedActivityRuntimeArgs): PreparedActivityRuntime {
  const { context, input, checkout, opening, authPaths, trustedAccess } = args;
  const { inlineActivityAuthSessions } = context;
  const writeInlineActivityAuthDiagnostic = inlineActivityAuthSessions.diagnostic;
  return {
    input: {
      activityId: input.activity.id,
      kind: input.activity.kind,
      projectId: input.job.projectId,
      productionUrl: input.productionUrl,
      testingContext: opening.testingContext,
      boundSignIns: input.boundSignIns,
      targetSuiteId: args.targetSuiteId,
      promptContractVersion: input.promptContractVersion,
      repositoryCheckoutLocator: checkout.directory,
      repositoryAvailable: checkout.commitSha !== null,
      repositoryCommitSha: checkout.commitSha,
      // The bound repository, checked out or not: the agents read it on GitHub.
      repository: runtimeRepository(input.repository),
      suites: input.suites,
      recordScreen: input.recordScreen,
    },
    options: {
      taskApi: args.taskApi,
      authDirectory: authPaths.authDirectory,
      sessionDirectory: args.sessionDirectory,
      ...legControlSeed(opening),
      logDirectory: resolve(authPaths.authDirectory, "..", "..", "logs"),
      projectHash: context.trackProjectHash(input.job.projectId),
      repositoryCheckoutRoot: context.repositoryCheckoutRoot,
      onContainerStarted: async (metadata) => {
        // The cache is written through to runtime_sessions here: this is the
        // one moment the host knows which container backs this run.
        await inlineActivityAuthSessions.remember({
          teamId: input.job.teamId,
          activityId: input.activity.id,
          session: {
            projectId: input.job.projectId,
            controlDirectory: metadata.controlDirectory,
            authViewerUrl: metadata.authViewerUrl,
            containerName: metadata.containerName,
          },
        });
        writeInlineActivityAuthDiagnostic("session_registered", {
          activityId: input.activity.id,
          projectId: input.job.projectId,
          containerName: metadata.containerName,
          runtimeMode: "single_session",
        });
      },
      ...(trustedAccess ? { trustedAccess } : {}),
    },
    dispose: (result) => disposeActivityRuntime(args, result),
  };
}

async function disposeActivityRuntime(
  args: PreparedActivityRuntimeArgs,
  result: ActivityDisposeResult,
): Promise<void> {
  const { context, input, capability, authProfile, authPaths, checkout } = args;
  const { inlineActivityAuthSessions } = context;
  const tenantStore = context.jobApi.store;
  const { cleanupRuntimeDirectory } = context.taskAuth;
  const writeInlineActivityAuthDiagnostic = inlineActivityAuthSessions.diagnostic;

  const inlineSession = inlineActivityAuthSessions.get(input.activity.id);
  if (inlineSession?.projectId === input.job.projectId) {
    await inlineActivityAuthSessions.forget(
      input.activity.id,
      `Activity runtime exited (${result?.status ?? "unknown"}).`,
    );
    writeInlineActivityAuthDiagnostic("session_released", {
      activityId: input.activity.id,
      projectId: input.job.projectId,
      containerName: inlineSession.containerName,
      resultStatus: result?.status ?? null,
    });
  }
  args.taskBroker.close();
  try {
    if (result) await retainActivityEvidence(args.port, result);
    await settleActivitySignIn(
      { tenantStore, taskAuth: context.taskAuth, capability, teamId: input.job.teamId, projectId: input.job.projectId, authProfile, authPaths },
      result,
    );
  } finally {
    await Promise.allSettled([
      checkout.cleanup(),
      cleanupRuntimeDirectory(result, "shipbash-activity-"),
    ]);
  }
}
