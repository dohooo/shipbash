import { isAbsolute, join, resolve } from "node:path";

import { JOB_API_HOST_VARIABLE, jobApiOrigin } from "@shipbash/contracts/runtime/job-api.mjs";

import type { DispatchExecutionInput } from "../types.ts";
import type { VercelSandboxBrowserStream } from "../vercel-sandbox-runtime.ts";
import { parseVercelSandboxBrowserStream } from "./browser-stream-url.ts";

const DEFAULT_ROOT = "/shipbash";

/** Everything one sandboxed task needs, read once from the process environment: no credential is among it. */
export interface SandboxTaskEnvironment {
  jobId: string;
  identityHash: string;
  /** Where the job API answers: the deployment's job API name, which the firewall forwards. */
  jobApiOrigin: string;
  expectedKind: DispatchExecutionInput["kind"];
  browserStream: VercelSandboxBrowserStream;
  rootDirectory: string;
  runtimeDirectory: string;
  authDirectory: string;
  repositoryCheckoutRoot: string;
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function absoluteEnvironmentPath(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): string {
  const value = environment[name]?.trim() || fallback;
  if (!isAbsolute(value) || value.includes("\0")) throw new Error(`${name} must be an absolute path.`);
  return resolve(value);
}

/** Where the task asks the job API: the name its launch set, refused when absent or not a host name. */
function configuredJobApiOrigin(environment: NodeJS.ProcessEnv): string {
  requiredEnvironment(environment, JOB_API_HOST_VARIABLE);
  return jobApiOrigin(environment);
}

function expectedKind(value: string): DispatchExecutionInput["kind"] {
  if (value !== "suite_run" && value !== "activity") {
    throw new Error("SHIPBASH_DISPATCH_KIND must be suite_run or activity.");
  }
  return value;
}

export function vercelSandboxTaskEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): SandboxTaskEnvironment {
  const rootDirectory = absoluteEnvironmentPath(environment, "SHIPBASH_RUNTIME_ROOT", DEFAULT_ROOT);
  return {
    jobId: requiredEnvironment(environment, "SHIPBASH_DISPATCH_JOB_ID"),
    identityHash: requiredEnvironment(environment, "SHIPBASH_DISPATCH_IDENTITY_HASH"),
    jobApiOrigin: configuredJobApiOrigin(environment),
    expectedKind: expectedKind(requiredEnvironment(environment, "SHIPBASH_DISPATCH_KIND")),
    browserStream: parseVercelSandboxBrowserStream(
      requiredEnvironment(environment, "SHIPBASH_BROWSER_STREAM_URL"),
    ),
    rootDirectory,
    runtimeDirectory: absoluteEnvironmentPath(
      environment,
      "SHIPBASH_RUNTIME_DIRECTORY",
      join(rootDirectory, "runtime"),
    ),
    authDirectory: absoluteEnvironmentPath(
      environment,
      "SHIPBASH_AUTH_ROOT",
      join(rootDirectory, "auth"),
    ),
    repositoryCheckoutRoot: join(rootDirectory, "repositories"),
  };
}
