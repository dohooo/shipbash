/**
 * Bootstrap phase 1: options and environment resolution.
 *
 * The public service option/handle shapes live here, next to the one function
 * that folds caller options, the deployment's configuration (configuration.ts)
 * and the local stack's SHIPBASH_* plumbing into an immutable record. Every
 * later bootstrap phase reads this record instead of touching process.env, so
 * the environment surface of the composition root stays visible in a single
 * file.
 */
import type { Server } from "node:http";
import { join, resolve } from "node:path";

import type { SupabaseArtifactStorage } from "../../artifact-storage.ts";
import type { SupabaseBrowserRecordingStorage } from "../../browser-recording-storage.ts";
import type { Configuration, Integrations } from "../../configuration.ts";
import { shipbashProcessEnvironmentValue } from "../../environment.ts";
import type { TenantStore } from "../../store/tenant-store.ts";
import { workerCapacity } from "../http-input.ts";
import { shortDigest } from "../short-digest.ts";
import { DEFAULT_HOST, DEFAULT_PORT, type ServiceDependencies } from "../support.ts";

export interface ShipBashServiceOptions {
  projectRoot: string;
  /** The deployment's configuration, read once at the entry (service.ts). */
  configuration: Configuration;
  port?: number | undefined;
  databaseUrl?: string | undefined;
  artifactStorage?: SupabaseArtifactStorage | null | undefined;
  browserRecordingStorage?: SupabaseBrowserRecordingStorage | null | undefined;
  tenantStore?: TenantStore | null | undefined;
  dependencies?: Partial<ServiceDependencies> | undefined;
  runtimeTemporaryDirectory?: string | undefined;
  /** Disable Dispatch execution for API-only integration harnesses. */
  runDispatchWorkers?: boolean | undefined;
  workerCapacity?: {
    suiteRuns?: number | undefined;
    activities?: number | undefined;
  };
}

export interface ShipBashService {
  readonly server: Server;
  readonly projectRoot: string;
  readonly shipbashDirectory: string;
  readonly baseUrl: string;
  start(): Promise<void>;
  close(): Promise<void>;
}

/** Options and environment, resolved once for every later phase. */
export interface ResolvedServiceConfig {
  projectRoot: string;
  port: number;
  host: string;
  shipbashDirectory: string;
  repositoryCheckoutRoot: string;
  /** Every hash a runtime container may run under; reconcile sweeps these. */
  containerProjectHashes: ReadonlySet<string>;
  trackProjectHash(projectId: string): string;
  baseUrl: string;
  publicBaseUrl: string;
  integrations: Integrations;
  backgroundWorkerCapacity: { suiteRuns: number; activities: number };
  databaseUrl: string | undefined;
}

export function resolveServiceConfig(options: ShipBashServiceOptions): ResolvedServiceConfig {
  const projectRoot = resolve(options.projectRoot);
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid ShipBash port: ${port}.`);
  const host = DEFAULT_HOST;
  const shipbashDirectory = join(projectRoot, ".shipbash");
  const repositoryCheckoutRoot = join(shipbashDirectory, "private", "repository-checkouts");
  const containerProjectHashes = new Set<string>();
  const trackProjectHash = (projectId: string): string => {
    const hash = shortDigest(projectId);
    containerProjectHashes.add(hash);
    return hash;
  };
  const baseUrl = `http://${host}:${port}`;
  const publicBaseUrl = options.configuration.publicUrl;
  const backgroundWorkerCapacity = {
    suiteRuns: workerCapacity(
      options.workerCapacity?.suiteRuns,
      shipbashProcessEnvironmentValue("SUITE_RUN_CONCURRENCY"),
      2,
      "SuiteRun worker capacity",
    ),
    activities: workerCapacity(
      options.workerCapacity?.activities,
      shipbashProcessEnvironmentValue("ACTIVITY_CONCURRENCY"),
      2,
      "Activity worker capacity",
    ),
  };
  const databaseUrl = options.databaseUrl ?? process.env.POSTGRES_URL?.trim();
  return {
    projectRoot,
    port,
    host,
    shipbashDirectory,
    repositoryCheckoutRoot,
    containerProjectHashes,
    trackProjectHash,
    baseUrl,
    publicBaseUrl,
    integrations: options.configuration.integrations,
    backgroundWorkerCapacity,
    databaseUrl,
  };
}
