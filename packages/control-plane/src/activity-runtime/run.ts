import { identifier } from "@shipbash/contracts/runtime/contract-values.mjs";
import { RUNNER_IMAGE } from "../runner-image.ts";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import type { ActivityControlSeed } from "../activity-control-files.ts";
import type { TaskApiConfig } from "@shipbash/contracts/runtime/job-api.mjs";
import { toolProcessEnvironment } from "../tool-environment.ts";
import { resolveRunnerMemoryLimit } from "../docker-runtime.ts";
import {
  releaseTrustedAccessFileWhenConsumed,
  type TrustedAccessRuntimeConfig,
} from "../trusted-access-runtime.ts";
import {
  containerName,
  openActivityLegLog,
  resolveImageIdentity,
  resolvePublishedPort,
  resultStatus,
  runCapture,
  waitForContainerId,
  writeActivityCancelSentinel,
  writeActivityRuntimeDiagnostic,
  type ActivityDockerRunResult,
  type ActivityLegLog,
} from "./container.ts";
import { buildActivityDockerRunArgs } from "./docker-args.ts";
import type { ActivityRuntimeEvent } from "./events.ts";
import { validateActivityRuntimeInput, type ActivityRuntimeInput } from "./input.ts";
import { checkedAbsolutePath } from "./paths.ts";
import { prepareActivityRuntimeLayout, type ActivityRuntimeLayout } from "./prepare.ts";
import { readActivityResultFile, type ActivityAgentResult } from "./result.ts";
import {
  attachActivityAbortWiring,
  createActivityEventPump,
  createActivityStderrRecorder,
} from "./stream.ts";

export interface ActivityControlMount {
  controlDirectory: string;
  adopt(path: string): Promise<void>;
}

export interface ActivityRuntimeOptions extends ActivityControlSeed {
  taskApi?: TaskApiConfig;
  image?: string;
  dockerBinary?: string;
  authDirectory?: string;
  /** The Project's saved browser sign-in; the runtime seals it as the leg's state.json.enc. */
  authState?: Record<string, unknown>;
  /**
   * The pi session home for this Activity's task, served to the runner at
   * control/pi-session when set: bind-mounted by Docker, linked by the Vercel
   * Sandbox runtime. The host seeds a Discovery's Journey store into it.
   */
  sessionDirectory?: string;
  /** Durable per-task directory for leg logs; container stderr survives here. */
  logDirectory?: string;
  temporaryDirectory?: string;
  repositoryCheckoutRoot?: string;
  projectHash?: string;
  trustedAccess?: TrustedAccessRuntimeConfig | null;
  onContainerStarted?: (metadata: ActivityContainerMetadata) => void | Promise<void>;
  /**
   * The leg's control mount is ready: where the worker delivers the Activity's
   * control inbox (dispatch-worker-control-inbox.ts). Both runtimes call it —
   * the Docker one beside onContainerStarted, the Vercel Sandbox one once the
   * task directory is laid out. `adopt` hands a path the worker wrote to the
   * runner's user where the two differ: the sandbox task runs as root beside
   * an unprivileged child, which must read and unlink those files.
   */
  onControlMount?: (mount: ActivityControlMount) => void | Promise<void>;
}

export interface ActivityContainerMetadata {
  containerId: string;
  containerName: string;
  activityId: string;
  projectHash: string;
  controlDirectory: string;
  authViewerUrl: string;
}

/** The pi session home must exist before Docker binds it. */
async function preparedSessionDirectory(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  const directory = checkedAbsolutePath(value, "sessionDirectory");
  await mkdir(directory, { recursive: true });
  return directory;
}

interface ActivityLaunchPlan {
  dockerBinary: string;
  image: string;
  imageIdentity: string | null;
  projectHash: string;
  name: string;
  humanAuthPassword: string;
  cidFile: string;
  legLog: ActivityLegLog;
  args: string[];
}

interface ActivitySupervision {
  input: ActivityRuntimeInput;
  onEvent: (event: ActivityRuntimeEvent) => void | Promise<void>;
  signal: AbortSignal;
  options: ActivityRuntimeOptions;
  layout: ActivityRuntimeLayout;
  plan: ActivityLaunchPlan;
}

/** Waits for the container id and announces it; reports the failure it stopped on. */
async function startActivityContainer(context: {
  input: ActivityRuntimeInput;
  layout: ActivityRuntimeLayout;
  plan: ActivityLaunchPlan;
  launchStderr: string[];
  onContainerStarted: ActivityRuntimeOptions["onContainerStarted"];
  onControlMount: ActivityRuntimeOptions["onControlMount"];
}): Promise<Error | null> {
  const { input, launchStderr } = context;
  const { cidFile, dockerBinary, humanAuthPassword, name, projectHash } = context.plan;
  const { controlDirectory } = context.layout;
  try {
    const id = await waitForContainerId(cidFile, launchStderr);
    const authViewerPort = await resolvePublishedPort(dockerBinary, name, 6080);
    writeActivityRuntimeDiagnostic("container_started", {
      activityId: input.activityId,
      projectId: input.projectId,
      containerName: name,
      containerId: id.slice(0, 12),
      authViewerPort,
    });
    // The container shares the host's user on the bind mount: nothing to adopt.
    await context.onControlMount?.({ controlDirectory, adopt: async () => undefined });
    await context.onContainerStarted?.({
      containerId: id,
      containerName: name,
      activityId: input.activityId,
      projectHash,
      controlDirectory,
      authViewerUrl: `http://127.0.0.1:${String(authViewerPort)}/vnc.html?autoconnect=1&resize=scale#password=${encodeURIComponent(humanAuthPassword)}`,
    });
    return null;
  } catch (error) {
    const containerStartError = error instanceof Error ? error : new Error(String(error));
    await writeActivityCancelSentinel(controlDirectory);
    await runCapture(dockerBinary, ["stop", "--time", "5", name]).catch(() => undefined);
    return containerStartError;
  }
}

async function removeActivityControlFiles(
  inputDirectory: string,
  controlDirectory: string,
  trustedAccessDirectory: string | undefined,
): Promise<void> {
  await Promise.all([
    rm(inputDirectory, { recursive: true, force: true }),
    ...(trustedAccessDirectory ? [rm(trustedAccessDirectory, { recursive: true, force: true })] : []),
    rm(join(controlDirectory, "cancel"), { force: true }),
  ]);
}

/** Reads the retained agent result; a clean exit without one is the leg failing. */
async function readActivityResult(context: {
  input: ActivityRuntimeInput;
  layout: ActivityRuntimeLayout;
  sensitiveValues: string[];
  exitCode: number | null;
  aborted: boolean;
}): Promise<ActivityAgentResult | null> {
  try {
    return await readActivityResultFile(
      context.layout.outputDirectory,
      context.input,
      context.sensitiveValues,
      context,
    );
  } catch (error) {
    await rm(context.layout.runtimeDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Starts the Runner container and records that the launch was requested. */
function launchActivityContainer(context: ActivitySupervision): ChildProcessByStdio<null, Readable, Readable> {
  const { input } = context;
  const { encryptionKey } = context.layout;
  const { args, dockerBinary, humanAuthPassword, image, imageIdentity, name } = context.plan;
  const child = spawn(dockerBinary, args, {
    env: toolProcessEnvironment({
      ...process.env,
      AGENT_BROWSER_ENCRYPTION_KEY: encryptionKey,
      SHIPBASH_HUMAN_AUTH_PASSWORD: humanAuthPassword,
    }),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  writeActivityRuntimeDiagnostic("container_launch_requested", {
    activityId: input.activityId,
    projectId: input.projectId,
    containerName: name,
    image, imageIdentity,
    runtimeMode: "single_session",
  });
  return child;
}

/** Runs the prepared container to exit and reads the leg's outcome back out. */
async function superviseActivityContainer(
  context: ActivitySupervision,
): Promise<ActivityDockerRunResult> {
  const { input, onEvent, options, signal } = context;
  const { controlDirectory, inputDirectory, outputDirectory } = context.layout;
  const { runtimeDirectory, trustedAccess, trustedAccessDirectory } = context.layout;
  const { dockerBinary, humanAuthPassword, legLog, name } = context.plan;

  let aborted = signal.aborted;
  if (aborted) await writeActivityCancelSentinel(controlDirectory);
  const child = launchActivityContainer(context);
  const sensitiveValues = [humanAuthPassword, ...(trustedAccess ? [trustedAccess.headerValue] : [])];
  const launchStderr: string[] = [];
  let spawnError: Error | null = null;
  const pump = createActivityEventPump({
    activityId: input.activityId,
    containerName: name,
    controlDirectory,
    dockerBinary,
    sensitiveValues,
    onEvent,
  });
  const stderrRecorder = createActivityStderrRecorder({ sensitiveValues, launchStderr, legLog });
  child.stdout.on("data", (chunk: Buffer) => { pump.push(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderrRecorder.push(chunk); });
  child.once("error", (error) => { spawnError = error; });
  const exitPromise = new Promise<number | null>((resolvePromise) => child.once("close", resolvePromise));
  let trustedAccessReleaseError: Error | null = null;
  const trustedAccessRelease = trustedAccessDirectory
    ? releaseTrustedAccessFileWhenConsumed({
        controlDirectory,
        trustedAccessDirectory,
        containerClosed: exitPromise,
      }).catch((error) => {
        trustedAccessReleaseError = error instanceof Error ? error : new Error(String(error));
        void writeActivityCancelSentinel(controlDirectory);
      })
    : Promise.resolve();
  const detachAbortWiring = attachActivityAbortWiring({
    signal,
    dockerBinary,
    containerName: name,
    controlDirectory,
    onAbortRequested: () => { aborted = true; },
  });

  const containerStartError = await startActivityContainer({
    input,
    layout: context.layout,
    plan: context.plan,
    launchStderr,
    onContainerStarted: options.onContainerStarted,
    onControlMount: options.onControlMount,
  });
  const exitCode = await exitPromise;
  await legLog.close({ exitCode, aborted, lastSequence: pump.lastSequence() });
  writeActivityRuntimeDiagnostic("container_exited", {
    activityId: input.activityId,
    projectId: input.projectId,
    containerName: name,
    exitCode,
    aborted,
    lastSequence: pump.lastSequence(),
  });
  await trustedAccessRelease;
  detachAbortWiring();
  pump.finish();
  let eventError: unknown;
  try {
    await pump.drain();
  } catch (error) {
    eventError = error;
  }
  stderrRecorder.flush();

  await removeActivityControlFiles(inputDirectory, controlDirectory, trustedAccessDirectory);
  const runtimeError = spawnError ?? containerStartError ?? pump.failure() ?? eventError ?? trustedAccessReleaseError;
  if (runtimeError) {
    await rm(runtimeDirectory, { recursive: true, force: true });
    throw runtimeError;
  }

  const result = await readActivityResult({
    input,
    layout: context.layout,
    sensitiveValues,
    exitCode,
    aborted,
  });
  // The container's last stderr lines ride along: without them a failed leg
  // reports the constant "failed before returning a valid result" while the
  // real sentence lives in a log nobody reads.
  return { status: resultStatus(exitCode, aborted, result), exitCode, outputDirectory, result, stderrTail: launchStderr.join("\n") };
}

export async function runActivityInDocker(
  inputValue: ActivityRuntimeInput,
  onEvent: (event: ActivityRuntimeEvent) => void | Promise<void>,
  signal: AbortSignal,
  options: ActivityRuntimeOptions = {},
): Promise<ActivityDockerRunResult> {
  const input = validateActivityRuntimeInput(inputValue);
  const layout = await prepareActivityRuntimeLayout(input, options);

  const dockerBinary = options.dockerBinary ?? "docker";
  const image = options.image ?? RUNNER_IMAGE;
  const projectHash = identifier(options.projectHash ?? createHash("sha256").update(input.projectId).digest("hex").slice(0, 24), "projectHash");
  const name = containerName(input.activityId);
  const humanAuthPassword = randomBytes(24).toString("base64url");
  const cidFile = join(layout.runtimeDirectory, "container.cid");
  const sessionDirectory = await preparedSessionDirectory(options.sessionDirectory);
  const imageIdentity = await resolveImageIdentity(dockerBinary, image);
  const legLog = await openActivityLegLog(options.logDirectory, name, imageIdentity, image);
  const args = buildActivityDockerRunArgs({
    image,
    containerName: name,
    activityId: input.activityId,
    projectHash,
    cidFile,
    inputDirectory: layout.inputDirectory,
    outputDirectory: layout.outputDirectory,
    controlDirectory: layout.controlDirectory,
    authDirectory: layout.authDirectory,
    sessionDirectory,
    repositoryDirectory: layout.repositoryDirectory,
    trustedAccessDirectory: layout.trustedAccessDirectory,
    memoryLimit: resolveRunnerMemoryLimit(),
  });

  return superviseActivityContainer({
    input,
    onEvent,
    signal,
    options,
    layout,
    plan: { dockerBinary, image, imageIdentity, projectHash, name, humanAuthPassword, cidFile, legLog, args },
  });
}
