import { type ChildProcessByStdio, spawn } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";

import type {
  ActivityDockerRunResult,
  ActivityRuntimeEvent,
  ActivityRuntimeInput,
  ActivityRuntimeOptions,
} from "../activity-runtime.ts";
import type {
  DockerRuntimeEvent,
  DockerRuntimeOptions,
  DockerSuiteInput,
  DockerSuiteRunResult,
} from "../docker-runtime.ts";
import type { ResolveBrowserStream } from "./browser-stream.ts";
import { absolutePath } from "./paths.ts";

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: false;
    stdio: ["ignore", "pipe", "pipe"];
    uid: number;
    gid: number;
  },
) => ChildProcessByStdio<null, Readable, Readable>;

export const VERCEL_SANDBOX_AGENT_UID = 10_001;
export const VERCEL_SANDBOX_AGENT_GID = 10_001;

export interface VercelSandboxRuntimeAdapterOptions {
  rootDirectory?: string;
  runtimeDirectory?: string;
  nodeBinary?: string;
  suiteRunnerScript?: string;
  activityRunnerScript?: string;
  environment?: NodeJS.ProcessEnv;
  forceKillAfterMs?: number;
  childUid?: number;
  childGid?: number;
  spawnProcess?: SpawnProcess;
  resolveBrowserStream?: ResolveBrowserStream;
  onStderr?: (line: string) => void;
}

export interface VercelSandboxRuntimeAdapters {
  runSuite(
    input: DockerSuiteInput,
    onEvent: (event: DockerRuntimeEvent) => void | Promise<void>,
    signal: AbortSignal,
    options?: DockerRuntimeOptions,
  ): Promise<DockerSuiteRunResult>;
  runActivity(
    input: ActivityRuntimeInput,
    onEvent: (event: ActivityRuntimeEvent) => void | Promise<void>,
    signal: AbortSignal,
    options?: ActivityRuntimeOptions,
  ): Promise<ActivityDockerRunResult>;
}

interface SandboxRuntimePaths {
  rootDirectory: string;
  runtimeDirectory: string;
  nodeBinary: string;
  suiteRunnerScript: string;
  activityRunnerScript: string;
}

interface SandboxChildSettings {
  forceKillAfterMs: number;
  childUid: number;
  childGid: number;
  spawnProcess: SpawnProcess;
  onStderr: (line: string) => void;
}

/**
 * Everything the two run lifecycles read out of the adapter options once, at
 * construction. `environment` and `resolveBrowserStream` stay optional here on
 * purpose: both are read at run time, not resolved up front.
 */
export interface SandboxRuntimeContext extends SandboxRuntimePaths, SandboxChildSettings {
  environment: NodeJS.ProcessEnv | undefined;
  resolveBrowserStream: ResolveBrowserStream | undefined;
}

/** Where the child runs from. Checked in the order the messages must surface. */
export function sandboxRuntimePaths(
  options: VercelSandboxRuntimeAdapterOptions,
): SandboxRuntimePaths {
  const rootDirectory = absolutePath(options.rootDirectory ?? "/shipbash", "rootDirectory");
  const runtimeDirectory = absolutePath(
    options.runtimeDirectory ?? join(rootDirectory, "runtime"),
    "runtimeDirectory",
  );
  return {
    rootDirectory,
    runtimeDirectory,
    nodeBinary: options.nodeBinary ?? process.execPath,
    suiteRunnerScript: absolutePath(
      options.suiteRunnerScript ?? join(runtimeDirectory, "suite-runner.mjs"),
      "suiteRunnerScript",
    ),
    activityRunnerScript: absolutePath(
      options.activityRunnerScript ?? join(runtimeDirectory, "activity-runner.mjs"),
      "activityRunnerScript",
    ),
  };
}

/** How the child is spawned and supervised. The identity guard fires first. */
export function sandboxChildSettings(
  options: VercelSandboxRuntimeAdapterOptions,
): SandboxChildSettings {
  const forceKillAfterMs = options.forceKillAfterMs ?? 10_000;
  const childUid = options.childUid ?? VERCEL_SANDBOX_AGENT_UID;
  const childGid = options.childGid ?? VERCEL_SANDBOX_AGENT_GID;
  if (!Number.isSafeInteger(childUid) || childUid < 1 || !Number.isSafeInteger(childGid) || childGid < 1) {
    throw new Error("Vercel Sandbox child UID and GID must be positive integers.");
  }
  if (!Number.isSafeInteger(forceKillAfterMs) || forceKillAfterMs < 100) {
    throw new Error("forceKillAfterMs must be an integer of at least 100 milliseconds.");
  }
  return {
    forceKillAfterMs,
    childUid,
    childGid,
    spawnProcess: options.spawnProcess ?? ((command, args, spawnOptions) =>
      spawn(command, [...args], spawnOptions)),
    onStderr: options.onStderr ?? ((line: string) => process.stderr.write(`${line}\n`)),
  };
}
