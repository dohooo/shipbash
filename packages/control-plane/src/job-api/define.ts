/**
 * How a job API method is declared, once: the zod tuple of its arguments and
 * what it runs, given the job the call is served for. The same declaration
 * serves the Sandbox over HTTP (server.ts) and the local lane in-process
 * (port.ts); how the client may resend it is the contracts' method table
 * (job-api.mjs JOB_METHOD_RETRY).
 */
import type { z } from "zod";

import type { SupabaseArtifactStorage } from "../artifact-storage.ts";
import type { SupabaseBrowserRecordingStorage } from "../browser-recording-storage.ts";
import type { GitHubAppProvider } from "../github-app-provider.ts";
import type { TenantStore } from "../store/tenant-store.ts";
import type { DispatchJobLeaseCapability, JobScope } from "../types.ts";

/** What every host serves the methods from: the console, the local service, and the local lane's in-process port. */
export interface JobApiResources {
  /** The console origin: the forward rule's target, and the origin a run's links name. */
  publicOrigin: string;
  store: TenantStore;
  /** Null where the host has no Supabase Storage; the storage methods then refuse. */
  artifactStorage: SupabaseArtifactStorage | null;
  browserRecordingStorage: SupabaseBrowserRecordingStorage | null;
  /** The GitHub App a checkout token is minted from; null where the host has none. */
  githubApp: Pick<GitHubAppProvider, "getApp"> | null;
}

/** One call's context: the host's resources, the job's lease capability and the job itself. */
export interface JobContext extends JobApiResources {
  capability: DispatchJobLeaseCapability;
  job: JobScope;
}

/** `Input` is what the tuple accepts before parsing; it must match the store's parameters. */
export interface JobMethod<Args extends unknown[], Result, Input = unknown> {
  readonly args: z.ZodType<Args, Input>;
  run(context: JobContext, ...args: Args): Promise<Result>;
}

/** Any method, with its arguments and result erased: what the registry's loops hold. */
export type AnyJobMethod = JobMethod<unknown[], unknown>;

export type JobArgs<Method> = Method extends JobMethod<infer Args, unknown> ? Args : never;
export type JobResult<Method> = Method extends { run(context: JobContext, ...args: never): Promise<infer Result> }
  ? Result
  : never;

export function defineJobMethod<Args extends unknown[], Result, Input = unknown>(
  method: JobMethod<Args, Result, Input>,
): JobMethod<Args, Result, Input> {
  return method;
}
