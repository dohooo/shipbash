/**
 * Bootstrap phase 2: store and provider construction.
 *
 * Builds every stateful backend the service composes over — the tenant store
 * facets, Supabase-backed storage, the GitHub tenancy surface,
 * the runtime dependency table, and the pg-boss job queue. Construction only:
 * nothing here starts a timer, opens a socket, or leases work.
 */
import type { AgentServices } from "@shipbash/contracts/runtime/agent-model.mjs";

import { SupabaseArtifactStorage } from "../../artifact-storage.ts";
import { SupabaseBrowserRecordingStorage } from "../../browser-recording-storage.ts";
import {
  reconcileProjectContainers,
  runSuiteInDocker,
} from "../../docker-runtime.ts";
import type { Integrations } from "../../configuration.ts";
import { shipbashProcessEnvironmentValue } from "../../environment.ts";
import { GitHubAppProvider } from "../../github-app-provider.ts";
import type { JobApiResources } from "../../job-api/define.ts";
import type { SlackAppConfiguration } from "../../slack-app.ts";
import { SlackTenantService } from "../../slack-tenant-service.ts";
import { GitHubTenantService } from "../../github-tenant-service.ts";
import {
  captureHumanAuthCandidate,
  startHumanAuthSession,
  stopHumanAuthSession,
} from "../../human-auth.ts";
import { ShipBashJobQueue } from "../../job-queue.ts";
import type { SignInKeyring } from "../../sign-in-crypto.ts";
import { createTenantStore, type TenantStore } from "../../store/tenant-store.ts";
import { createStoreGateways, type StoreGateways } from "../store-gateways.ts";
import type { ServiceDependencies } from "../support.ts";
import type { ResolvedServiceConfig, ShipBashServiceOptions } from "./options.ts";

export interface ServiceStores {
  artifactStorage: SupabaseArtifactStorage | null;
  browserRecordingStorage: SupabaseBrowserRecordingStorage | null;
  tenantStore: TenantStore | null;
  /** What the job API serves from, here and in a local run's in-process port; null store-less. */
  jobApi: JobApiResources | null;
  actorSigningSecret: string;
  githubAppProvider: GitHubAppProvider | undefined;
  github: GitHubTenantService | undefined;
  slack: SlackTenantService | undefined;
  /** What the @ShipBash bot is built from, checked; null where the deployment has no Slack app. */
  slackBot: { configuration: SlackAppConfiguration; databaseUrl: string; jev: AgentServices["jev"] } | null;
  gateways: StoreGateways;
  deps: ServiceDependencies;
  /** The one docker binary override, spread into every runtime call that takes it. */
  dockerBinaryOption(): { dockerBinary?: string };
  reconcileKnownProjectContainers(preserveContainerNames?: readonly string[]): Promise<void>;
  jobQueue: ShipBashJobQueue | null;
}

/**
 * The tenant store, or a clear operator error: the service keeps all state in
 * Postgres, and a start without POSTGRES_URL is an operator mistake.
 * A harness may still pass `tenantStore: null` explicitly to exercise the
 * store-less 503 surface.
 */
function createConfiguredTenantStore(
  options: ShipBashServiceOptions,
  databaseUrl: string | undefined,
  signInKeyring: SignInKeyring,
): TenantStore | null {
  if (options.tenantStore !== undefined) return options.tenantStore;
  if (!databaseUrl) {
    throw new Error(
      "ShipBash needs POSTGRES_URL: the service keeps its state in Postgres. Point " +
        "POSTGRES_URL at the ShipBash database before starting the service. The dev stack " +
        "sets this automatically.",
    );
  }
  return createTenantStore(databaseUrl, { signInKeyring, runQuota: options.configuration.runQuota });
}

/**
 * The two Supabase-backed stores. Both need the database URL and the API
 * credentials; an option supplied by a harness always wins outright.
 */
function supabaseCredentials(
  databaseUrl: string | undefined,
): { apiUrl: string; serviceRoleKey: string } | null {
  const apiUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!databaseUrl || !apiUrl || !serviceRoleKey) return null;
  return { apiUrl, serviceRoleKey };
}

function createStorageBackends(
  options: ShipBashServiceOptions,
  databaseUrl: string | undefined,
): Pick<ServiceStores, "artifactStorage" | "browserRecordingStorage"> {
  // Both Supabase stores need the database URL as well as the API
  // credentials.
  const supabase = supabaseCredentials(databaseUrl);
  return {
    artifactStorage:
      options.artifactStorage ?? (supabase ? new SupabaseArtifactStorage(supabase) : null),
    browserRecordingStorage:
      options.browserRecordingStorage ??
      (supabase
        ? new SupabaseBrowserRecordingStorage({
            apiUrl: supabase.apiUrl,
            serviceRoleKey: supabase.serviceRoleKey,
          })
        : null),
  };
}

/**
 * The GitHub tenancy surface. All three pieces hang off the tenant store and
 * the configured integration, and the webhook control additionally needs the
 * shared secret, so a service without them serves no GitHub routes.
 */
function createGitHubSurface(input: {
  tenantStore: TenantStore | null;
  github: Integrations["github"];
  publicBaseUrl: string;
  shipbashDirectory: string;
}): Pick<ServiceStores, "githubAppProvider" | "github"> {
  const { tenantStore, github, publicBaseUrl, shipbashDirectory } = input;
  const githubAppProvider = tenantStore && github
    ? new GitHubAppProvider({ integration: github, shipbashDirectory })
    : undefined;
  return {
    githubAppProvider,
    github: githubAppProvider && tenantStore
      ? new GitHubTenantService(githubAppProvider, tenantStore.actor, tenantStore.internal, publicBaseUrl)
      : undefined,
  };
}

/**
 * The Slack surface. Both halves need the app's credentials, so a deployment
 * without them serves no Slack routes at all — and one that has only some of
 * them is refused here rather than at the first redirect. The webhook's bot
 * keeps its state in the service's database, over a connection of its own.
 * The bot itself is built with the gateways (gateways.ts): its conversations
 * queue work and its Stop ends sign-ins.
 */
function createSlackSurface(input: {
  tenantStore: TenantStore | null;
  slack: SlackAppConfiguration | null;
  jev: AgentServices["jev"];
  publicBaseUrl: string;
  databaseUrl: string | undefined;
}): Pick<ServiceStores, "slack" | "slackBot"> {
  const { tenantStore, slack: configuration, jev, publicBaseUrl, databaseUrl } = input;
  if (!configuration || !tenantStore) return { slack: undefined, slackBot: null };
  if (!databaseUrl) {
    throw new Error("The Slack app needs POSTGRES_URL: its bot keeps its state in the service's database.");
  }
  return {
    slack: new SlackTenantService(configuration, tenantStore.actor, publicBaseUrl),
    slackBot: { configuration, databaseUrl, jev },
  };
}

export function createServiceStores(
  options: ShipBashServiceOptions,
  config: ResolvedServiceConfig,
): ServiceStores {
  const { shipbashDirectory, publicBaseUrl, databaseUrl } = config;
  const { artifactStorage, browserRecordingStorage } =
    createStorageBackends(options, databaseUrl);
  const { actorSigningSecret, agents, integrations, signInKeyring } = options.configuration;
  const tenantStore = createConfiguredTenantStore(options, databaseUrl, signInKeyring);
  const { githubAppProvider, github } = createGitHubSurface({
    tenantStore, github: integrations.github, publicBaseUrl, shipbashDirectory,
  });
  const { slack, slackBot } = createSlackSurface({ tenantStore, slack: integrations.slack, jev: agents.jev, publicBaseUrl, databaseUrl });
  const gateways = createStoreGateways({
    tenantStore,
    artifactStorage,
    browserRecordingStorage,
  });
  const deps: ServiceDependencies = {
    startHumanAuthSession,
    stopHumanAuthSession,
    captureHumanAuthCandidate,
    runSuiteInDocker,
    reconcileProjectContainers,
    ...options.dependencies,
  };
  /** The one docker binary override, spread into every runtime call that takes it. */
  const dockerBinaryOption = (): { dockerBinary?: string } => {
    const binary = shipbashProcessEnvironmentValue("DOCKER_BINARY");
    return binary ? { dockerBinary: binary } : {};
  };
  const reconcileKnownProjectContainers = async (preserveContainerNames: readonly string[] = []): Promise<void> => {
    await Promise.all(
      [...config.containerProjectHashes].map((hash) => deps.reconcileProjectContainers(hash, {
        ...(preserveContainerNames.length > 0 ? { preserveContainerNames } : {}),
        ...dockerBinaryOption(),
      })),
    );
  };
  const jobQueue = databaseUrl && tenantStore
    ? ShipBashJobQueue.forPostgres(databaseUrl)
    : null;
  const jobApi = tenantStore && {
    publicOrigin: publicBaseUrl,
    store: tenantStore,
    artifactStorage,
    browserRecordingStorage,
    githubApp: githubAppProvider ?? null,
  };
  return {
    artifactStorage,
    browserRecordingStorage,
    tenantStore,
    jobApi,
    actorSigningSecret,
    githubAppProvider,
    github,
    slack,
    slackBot,
    gateways,
    deps,
    dockerBinaryOption,
    reconcileKnownProjectContainers,
    jobQueue,
  };
}
