/**
 * Human authentication session lifecycle: the per-run and per-activity
 * takeover containers, guarded by the handoff ownership table.
 *
 * One factory owns the start/stop registries (humanAuthSessions and the
 * in-flight starts and stops). The mechanics live in ./auth-sessions/ — the
 * shared registries and the task lanes each in their own module — and routes
 * reach sessions only through the surface below.
 */
import type { HumanAuthSession } from "../human-auth.ts";
import type { TenantStore } from "../store/tenant-store.ts";
import type { TrustedAccessRuntimeConfig } from "../trusted-access-runtime.ts";
import type { ApiOptions } from "../api.ts";
import type { AuthHandoffOwnership } from "./auth-handoff-ownership.ts";
import { createAuthSessionState, taskAuthSessionId, authLandingUrl } from "./auth-sessions/state.ts";
import { createTaskAuthLane } from "./auth-sessions/task-lane.ts";
import type { InlineActivitySessionRegistry } from "./runtime-session-registry.ts";
import type { ServiceDependencies } from "./support.ts";

/** What the session lifecycle borrows from the service closure. */
export interface AuthSessionContext {
  deps: ServiceDependencies;
  tenantStore: TenantStore | null;
  inlineActivityAuthSessions: InlineActivitySessionRegistry;
  ownership: AuthHandoffOwnership;
  shipbashDirectory: string;
  trackProjectHash(projectId: string): string;
  dockerBinaryOption(): { dockerBinary?: string };
  isShuttingDown(): boolean;
}

/** Reopening after a refusal keeps the refused capture and loads it into the fresh viewer. */
export interface StartAuthOptions {
  preloadRefusedCandidate?: boolean;
}

export interface AuthSessions {
  /** Live sessions by id; routes read viewer URLs, close() drains it. */
  sessions: Map<string, HumanAuthSession>;
  /** In-flight session starts; close() awaits them before teardown. */
  starts: Map<string, Promise<HumanAuthSession>>;
  authLandingUrl(value: string): string;
  taskAuthSessionId(projectId: string, targetKind: "run" | "activity", targetId: string): string;
  resolveTrustedAccess(
    teamId: string,
    projectId: string,
    productionUrl: string,
  ): Promise<TrustedAccessRuntimeConfig | undefined>;
  startTaskAuthSession(input: {
    teamId: string;
    projectId: string;
    targetKind: "run" | "activity";
    targetId: string;
    productionUrl: string;
  } & StartAuthOptions): Promise<HumanAuthSession>;
  stopTaskAuthSession(
    projectId: string,
    sessionId: string,
    targetKind: "run" | "activity",
    targetId: string,
  ): Promise<void>;
  requireActivityAwaitingAuth(
    input: Parameters<NonNullable<ApiOptions["auth"]>["status"]>[0],
  ): Promise<void>;
}

export function createAuthSessions(context: AuthSessionContext): AuthSessions {
  const state = createAuthSessionState();
  const task = createTaskAuthLane(context, state);

  return {
    sessions: state.sessions,
    starts: state.starts,
    authLandingUrl,
    taskAuthSessionId,
    resolveTrustedAccess: task.resolveTrustedAccess,
    startTaskAuthSession: task.startTaskAuthSession,
    stopTaskAuthSession: task.stopTaskAuthSession,
    requireActivityAwaitingAuth: task.requireActivityAwaitingAuth,
  };
}
