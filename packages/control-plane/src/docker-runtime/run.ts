import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { TaskApiConfig } from "@shipbash/contracts/runtime/job-api.mjs";
import { toolProcessEnvironment } from "../tool-environment.ts";
import {
  releaseTrustedAccessFileWhenConsumed,
  type TrustedAccessRuntimeConfig,
} from "../trusted-access-runtime.ts";
import type { RunHistoryWalk } from "../run-history.ts";
import { RUNNER_IMAGE } from "../runner-image.ts";
import { buildDockerRunArgs, resolveRunnerMemoryLimit } from "./docker-args.ts";
import type { DockerRuntimeEvent } from "./events.ts";
import { validateSuiteInput, type DockerSuiteInput } from "./input.ts";
import { prepareSuiteRuntimeLayout, type SuiteRuntimeLayout } from "./prepare.ts";
import {
  containerNameForSuite,
  mapContainerExit,
  stopContainer,
  waitForContainerId,
  writeCancelSentinel,
} from "./reconcile.ts";
import {
  attachSuiteAbortWiring,
  createStderrSink,
  createSuiteEventPump,
} from "./stream.ts";
import { validateIdentifier } from "./validate.ts";

export interface DockerRuntimeOptions {
  taskApi?: TaskApiConfig;
  image?: string;
  dockerBinary?: string;
  authDirectory?: string;
  encryptionKey?: string;
  temporaryDirectory?: string;
  projectHash?: string;
  trustedAccess?: TrustedAccessRuntimeConfig | null;
  /** Each Case's newest earlier walk, which its brief opens with, written into control/history/ (agent-data/opening.ts). */
  caseOpenings?: Record<string, RunHistoryWalk>;
  /** Host-created output root, announced before Runner events can arrive. */
  onOutputDirectoryReady?: (directory: string) => void;
  /** Drains evidence readers before a failed runtime removes its output root. */
  onBeforeOutputCleanup?: () => Promise<void>;
  onContainerStarted?: (metadata: DockerContainerMetadata) => void | Promise<void>;
}

export interface DockerContainerMetadata {
  containerId: string;
  containerName: string;
  suiteRunId: string;
  projectHash: string;
}

export interface DockerSuiteRunResult {
  status: "completed" | "canceled" | "failed";
  exitCode: number | null;
  outputDirectory: string;
  authDirectory: string;
}

/** Waits for the container id and announces it; reports the failure it stopped on. */
async function startSuiteContainer(context: {
  cidFile: string;
  dockerBinary: string;
  containerName: string;
  controlDirectory: string;
  suiteRunId: string;
  projectHash: string;
  onContainerStarted: DockerRuntimeOptions["onContainerStarted"];
  onFailure: () => void;
}): Promise<Error | null> {
  const { containerName, controlDirectory, dockerBinary, projectHash, suiteRunId } = context;
  try {
    const containerId = await waitForContainerId(context.cidFile);
    await context.onContainerStarted?.({
      containerId,
      containerName,
      suiteRunId,
      projectHash,
    });
    return null;
  } catch (error) {
    const containerStartError = error instanceof Error ? error : new Error(String(error));
    context.onFailure();
    await writeCancelSentinel(controlDirectory);
    await stopContainer(dockerBinary, containerName);
    return containerStartError;
  }
}

async function removeSuiteControlFiles(
  inputDirectory: string,
  controlDirectory: string,
  trustedAccessDirectory: string | undefined,
): Promise<void> {
  await Promise.all([
    rm(inputDirectory, { recursive: true, force: true }),
    ...(trustedAccessDirectory ? [rm(trustedAccessDirectory, { recursive: true, force: true })] : []),
    rm(join(controlDirectory, "cancel"), { force: true }),
    rm(join(controlDirectory, "auth-complete"), { force: true }),
    rm(join(controlDirectory, "auth-cancel"), { force: true }),
  ]);
}

interface SuiteSupervision {
  suiteRunId: string;
  signal: AbortSignal;
  onEvent: (event: DockerRuntimeEvent) => void | Promise<void>;
  onContainerStarted: DockerRuntimeOptions["onContainerStarted"];
  onBeforeOutputCleanup: DockerRuntimeOptions["onBeforeOutputCleanup"];
  dockerBinary: string;
  args: string[];
  containerName: string;
  cidFile: string;
  projectHash: string;
  layout: SuiteRuntimeLayout;
}

/** Runs the prepared container to exit and reads the run's outcome back out. */
async function superviseSuiteContainer(context: SuiteSupervision): Promise<DockerSuiteRunResult> {
  const { args, cidFile, containerName, dockerBinary, onContainerStarted, onEvent, signal } = context;
  const { authDirectory, controlDirectory, encryptionKey, inputDirectory } = context.layout;
  const { outputDirectory, runtimeDirectory, trustedAccess, trustedAccessDirectory } = context.layout;

  let abortRequested = signal.aborted;
  if (abortRequested) {
    await writeCancelSentinel(controlDirectory);
  }

  const child = spawn(dockerBinary, args, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: toolProcessEnvironment({
      ...process.env,
      AGENT_BROWSER_ENCRYPTION_KEY: encryptionKey,
    }),
  });
  let spawnError: Error | null = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  const exitCodePromise = new Promise<number | null>((resolvePromise) => {
    child.once("close", resolvePromise);
  });
  const sensitiveValues = trustedAccess ? [trustedAccess.headerValue] : [];
  const pump = createSuiteEventPump({
    dockerBinary,
    containerName,
    controlDirectory,
    encryptionKey,
    sensitiveValues,
    onEvent,
    isAbortRequested: () => abortRequested,
  });
  let trustedAccessReleaseError: Error | null = null;
  const trustedAccessRelease = trustedAccessDirectory
    ? releaseTrustedAccessFileWhenConsumed({
        controlDirectory,
        trustedAccessDirectory,
        containerClosed: exitCodePromise,
      }).catch((error) => {
        trustedAccessReleaseError = error instanceof Error ? error : new Error(String(error));
        void writeCancelSentinel(controlDirectory);
      })
    : Promise.resolve();
  const stderrSink = createStderrSink(encryptionKey, sensitiveValues);

  child.stdout.on("data", (chunk: Buffer) => {
    pump.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrSink.push(chunk);
  });

  const detachAbortWiring = attachSuiteAbortWiring({
    signal,
    dockerBinary,
    containerName,
    controlDirectory,
    alreadyRequested: abortRequested,
    onAbortRequested: () => {
      abortRequested = true;
    },
  });

  const containerStartError = await startSuiteContainer({
    cidFile,
    dockerBinary,
    containerName,
    controlDirectory,
    suiteRunId: context.suiteRunId,
    projectHash: context.projectHash,
    onContainerStarted,
    onFailure: pump.suppressCancelEvents,
  });
  const exitCode = await exitCodePromise;
  await trustedAccessRelease;
  stderrSink.flush();

  detachAbortWiring();
  pump.finish();
  let eventError: unknown;
  try {
    await pump.drain();
  } catch (error) {
    eventError = error;
  }

  await removeSuiteControlFiles(inputDirectory, controlDirectory, trustedAccessDirectory);

  const runtimeError = spawnError
    ?? containerStartError
    ?? pump.failure()
    ?? eventError
    ?? trustedAccessReleaseError;
  if (runtimeError) {
    await context.onBeforeOutputCleanup?.();
    await rm(runtimeDirectory, { recursive: true, force: true });
    throw runtimeError;
  }

  return {
    status: mapContainerExit(exitCode, abortRequested, pump.lastEventType()),
    exitCode,
    outputDirectory,
    authDirectory,
  };
}

export async function runSuiteInDocker(
  input: DockerSuiteInput,
  onEvent: (event: DockerRuntimeEvent) => void | Promise<void>,
  signal: AbortSignal,
  options: DockerRuntimeOptions = {},
): Promise<DockerSuiteRunResult> {
  const suite = validateSuiteInput(input);
  const dockerBinary = options.dockerBinary ?? "docker";
  const image = options.image ?? RUNNER_IMAGE;
  const projectHash = validateIdentifier(
    options.projectHash ??
      createHash("sha256").update(resolve(process.cwd())).digest("hex").slice(0, 24),
    "projectHash",
  );
  const layout = await prepareSuiteRuntimeLayout(suite, options);
  try {
    options.onOutputDirectoryReady?.(layout.outputDirectory);
  } catch (error) {
    await rm(layout.runtimeDirectory, { recursive: true, force: true });
    throw error;
  }
  const { authDirectory, controlDirectory, inputDirectory, outputDirectory, runtimeDirectory, trustedAccessDirectory } = layout;
  const containerName = containerNameForSuite(suite.suiteRunId);
  const cidFile = join(runtimeDirectory, "container.cid");
  const args = buildDockerRunArgs({
    image,
    containerName,
    suiteRunId: suite.suiteRunId,
    projectHash,
    cidFile,
    inputDirectory,
    outputDirectory,
    controlDirectory,
    authDirectory,
    trustedAccessDirectory,
    includeEncryptionKey: true,
    memoryLimit: resolveRunnerMemoryLimit(),
  });

  return superviseSuiteContainer({
    suiteRunId: suite.suiteRunId,
    signal,
    onEvent,
    onContainerStarted: options.onContainerStarted,
    onBeforeOutputCleanup: options.onBeforeOutputCleanup,
    dockerBinary,
    args,
    containerName,
    cidFile,
    projectHash,
    layout,
  });
}
