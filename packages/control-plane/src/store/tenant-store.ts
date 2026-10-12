/**
 * The tenant store's construction helper. The store has three facets: the
 * actor-facing facet (auth spine + actor doors), the job-capability facet
 * (lease-authorized writes and the agent's lease-scoped reads), and the
 * internal/trusted facet (schedulers, reconcilers, service lanes). This is
 * the only place that builds them, over one shared postgres pool.
 */
import { AgentDataStore } from "./agent-data-store.ts";
import { TaskCredentialStore } from "./task-credentials.ts";
import { AuthAttentionStore } from "./auth-attention.ts";
import { AuthenticatorStore } from "./authenticators.ts";
import { ActorStore } from "./actor-store.ts";
import type { SignInKeyring } from "../sign-in-crypto.ts";
import { StoreConnection } from "./connection.ts";
import { InternalStore } from "./internal-store.ts";
import { JobStore } from "./job-store.ts";
import { PublicRunStore } from "./public-run-store.ts";
import { SignInTakeoverStore } from "./sign-in-takeovers.ts";
import { TargetAuthHandoffStore } from "./target-auth-handoffs.ts";
import { TargetAuthStateStore } from "./target-auth-state.ts";
import { CliStore } from "./cli-store.ts";

export interface TenantStore {
  readonly actor: ActorStore;
  readonly credentials: TaskCredentialStore;
  readonly targetAuthState: TargetAuthStateStore;
  readonly targetAuthHandoffs: TargetAuthHandoffStore;
  readonly signInTakeovers: SignInTakeoverStore;
  readonly authenticators: AuthenticatorStore;
  readonly authAttention: AuthAttentionStore;
  readonly jobs: JobStore;
  readonly internal: InternalStore;
  readonly publicRuns: PublicRunStore;
  readonly cli: CliStore;
  readonly agentData: AgentDataStore;
  close(): Promise<void>;
}

export function createTenantStore(
  databaseUrl: string,
  options: { maxConnections?: number; signInKeyring?: SignInKeyring | null; runQuota: boolean },
): TenantStore {
  const connection = new StoreConnection(databaseUrl, options);
  const internal = new InternalStore(connection, options.signInKeyring ?? null);
  return {
    actor: new ActorStore(connection, options.signInKeyring ?? null),
    credentials: new TaskCredentialStore(connection, options.signInKeyring ?? null),
    targetAuthState: new TargetAuthStateStore(connection, options.signInKeyring ?? null),
    targetAuthHandoffs: new TargetAuthHandoffStore(connection),
    signInTakeovers: new SignInTakeoverStore(connection),
    authenticators: new AuthenticatorStore(connection, options.signInKeyring ?? null),
    authAttention: new AuthAttentionStore(connection),
    jobs: new JobStore(connection),
    internal,
    publicRuns: new PublicRunStore(connection),
    cli: new CliStore(connection),
    agentData: new AgentDataStore(connection, internal),
    close: () => connection.close(),
  };
}
