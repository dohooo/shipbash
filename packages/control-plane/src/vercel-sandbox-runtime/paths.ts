import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import type { ActivityRuntimeOptions } from "../activity-runtime.ts";
import type { DockerRuntimeOptions } from "../docker-runtime.ts";

/**
 * Where one sandboxed task's directories are. Every path here is absolute and
 * checked; the task root is derived from the task id so a re-dispatch of the
 * same run reuses (and first clears) the same tree.
 */
export interface RuntimeLayout {
  root: string;
  taskRoot: string;
  inputDirectory: string;
  outputDirectory: string;
  controlDirectory: string;
  workDirectory: string;
  trustedAccessDirectory: string;
  authDirectory: string;
  homeDirectory: string;
  runtimeDirectory: string;
}

interface RuntimeRootPaths {
  rootDirectory: string;
  runtimeDirectory: string;
}

export function absolutePath(value: string, field: string): string {
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${field} must be an absolute path.`);
  }
  return resolve(value);
}

function taskDirectoryName(
  prefix: "shipbash-runner" | "shipbash-activity",
  taskId: string,
): string {
  const digest = createHash("sha256").update(taskId).digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

export function runtimeLayout(
  configuration: RuntimeRootPaths,
  prefix: "shipbash-runner" | "shipbash-activity",
  taskId: string,
  runtimeOptions: DockerRuntimeOptions | ActivityRuntimeOptions,
): RuntimeLayout {
  const root = absolutePath(configuration.rootDirectory, "rootDirectory");
  const taskRoot = join(root, "tasks", taskDirectoryName(prefix, taskId));
  const authDirectory = absolutePath(
    runtimeOptions.authDirectory ?? join(root, "auth"),
    "authDirectory",
  );
  return {
    root,
    taskRoot,
    inputDirectory: join(taskRoot, "input"),
    outputDirectory: join(taskRoot, "output"),
    controlDirectory: join(taskRoot, "control"),
    workDirectory: join(taskRoot, "work"),
    trustedAccessDirectory: join(taskRoot, "trusted-access"),
    authDirectory,
    homeDirectory: join(root, "home"),
    runtimeDirectory: absolutePath(configuration.runtimeDirectory, "runtimeDirectory"),
  };
}
