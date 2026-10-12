/**
 * What only a hosted deployment reads, because only there does the console
 * itself keep the state and create the Sandboxes: on a laptop the dev stack
 * hands its service the local database, and runs come up in Docker.
 */
import { jobApiHost } from "@shipbash/contracts/runtime/job-api-contract.mjs";

import { type ConfigurationReport, optionalValue, parsed, requiredValue } from "./configuration-report.ts";
import { type RuntimeBundle, resolveRuntimeBundle } from "./vercel-sandbox-dispatch/runtime-bundle.ts";

type Environment = NodeJS.ProcessEnv;

export interface HostedConfiguration {
  databaseUrl: string;
  supabase: { apiUrl: string; serviceRoleKey: string };
  /** The Vercel Container Registry image every Sandbox is created from. */
  runnerImage: string;
  /** The name a task Sandbox asks the job API at (job-api-contract.mjs). */
  jobApiHost: string;
  /** What Vercel Cron sends to the schedules route. */
  cronSecret: string;
  /**
   * Where Sandboxes are created: beside the functions that talk to them on
   * every event. Vercel sets it only at runtime, so a build reads null.
   */
  sandboxRegion: string | null;
  /** The release's code layer over the image; null runs the image's own. */
  runtimeBundle: RuntimeBundle | null;
}

/** Variables the hosted console reads only for the browser bundle; checked here so a deployment hears about them first. */
const PUBLIC_BUNDLE_VARIABLES = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] as const;

function cronSecret(environment: Environment, report: ConfigurationReport): string | null {
  const value = requiredValue(environment, "CRON_SECRET", report);
  if (value === null || Buffer.byteLength(value, "utf8") >= 16) return value;
  report.invalid.push("CRON_SECRET must contain at least 16 bytes.");
  return null;
}

function runnerImage(environment: Environment, report: ConfigurationReport): string | null {
  const value = requiredValue(environment, "SHIPBASH_RUNNER_IMAGE", report);
  if (value === null || !/[\0\r\n]/u.test(value)) return value;
  report.invalid.push("SHIPBASH_RUNNER_IMAGE must reference a Vercel Container Registry image.");
  return null;
}

export function readHosted(environment: Environment, report: ConfigurationReport): HostedConfiguration | null {
  const databaseUrl = requiredValue(environment, "POSTGRES_URL", report);
  const apiUrl = requiredValue(environment, "SUPABASE_URL", report);
  const serviceRoleKey = requiredValue(environment, "SUPABASE_SECRET_KEY", report);
  for (const name of PUBLIC_BUNDLE_VARIABLES) requiredValue(environment, name, report);
  const image = runnerImage(environment, report);
  const host = environment.SHIPBASH_JOB_API_HOST?.trim()
    ? parsed(report, () => jobApiHost(environment))
    : requiredValue(environment, "SHIPBASH_JOB_API_HOST", report);
  const cron = cronSecret(environment, report);
  const sandboxRegion = optionalValue(environment, "VERCEL_REGION");
  const runtimeBundle = parsed(report, () => resolveRuntimeBundle(environment));
  if (!databaseUrl || !apiUrl || !serviceRoleKey || !image || !host || !cron) return null;
  return {
    databaseUrl,
    supabase: { apiUrl, serviceRoleKey },
    runnerImage: image,
    jobApiHost: host,
    cronSecret: cron,
    sandboxRegion,
    runtimeBundle,
  };
}
