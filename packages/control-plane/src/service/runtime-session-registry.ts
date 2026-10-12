/**
 * The takeover registry: an in-memory cache in front of `runtime_sessions`.
 *
 * A cache alone would strand runs across a service restart, so every write
 * also lands in the table and every miss falls back to it: an Activity whose
 * container outlived the service is still reachable for takeover and for
 * answering a question.
 */
import type postgres from "postgres";

import { terminalizeWaitingWorkForDeadSessions } from "../store/runtime-session-liveness.ts";
import {
  RUNTIME_SESSION_DEAD_REASON,
  classifyRuntimeSessions,
  listRunningManagedContainerNames,
} from "./runtime-session-liveness.ts";
import {
  closeRuntimeSession,
  listOpenRuntimeSessions,
  openRuntimeSession,
  type RuntimeSessionPhase,
  type RuntimeSessionRecord,
} from "../store/runtime-sessions.ts";

/** What every takeover and interaction path needs to reach a live container. */
export interface InlineActivitySession {
  projectId: string;
  controlDirectory: string;
  authViewerUrl: string;
  containerName: string;
}

export interface InlineActivitySessionRegistry {
  /** Cache-only read, for callers already inside a request the cache served. */
  get(activityId: string): InlineActivitySession | undefined;
  /** The adopted session for an Activity, re-seeded by each sweep. */
  resolve(activityId: string, projectId?: string): Promise<InlineActivitySession | undefined>;
  remember(input: {
    teamId: string;
    activityId: string;
    session: InlineActivitySession;
    phase?: Exclude<RuntimeSessionPhase, "ended">;
  }): Promise<void>;
  forget(activityId: string, reason: string): Promise<void>;
  /** Drops the cache entry only — the row is already closed by the reconciler. */
  evict(activityId: string): void;
  listOpen(): Promise<RuntimeSessionRecord[]>;
  /**
   * Records a Suite Run's takeover viewer container.
   *
   * The viewer carries the managed and project-hash labels, so unregistered,
   * the boot sweep would force-remove it while the Run stays waiting_for_auth,
   * and the run view's 2s poll, which reads through `peek`, would return null
   * forever and the takeover iframe would vanish. Registering it makes it
   * adoptable across a restart.
   */
  rememberViewer(input: {
    teamId: string;
    projectId: string;
    runId: string;
    containerName: string;
    viewerUrl: string;
  }): Promise<void>;
  /** The adopted viewer URL behind `peek` for a Suite Run. */
  resolveViewer(projectId: string, runId: string): Promise<string | null>;
  forgetViewer(runId: string, reason: string): Promise<void>;
  /**
   * Enforces the invariant once and returns the container names still worth
   * keeping, for the caller to spare from the Project container sweep.
   */
  sweep(): Promise<string[]>;
  diagnostic(event: string, fields: Record<string, string | number | boolean | null>): void;
}

/** The caches and dependencies every registry method shares. */
interface RegistryState {
  resolveSql: () => postgres.Sql | null;
  dockerBinary: string | undefined;
  cache: Map<string, InlineActivitySession>;
  viewerCache: Map<string, { projectId: string; viewerUrl: string }>;
}

export function createInlineActivitySessionRegistry(
  resolveSql: () => postgres.Sql | null,
  dockerBinary?: string,
): InlineActivitySessionRegistry {
  const cache = new Map<string, InlineActivitySession>();
  /**
   * Suite Run viewer URLs, seeded by boot adoption. The run detail view polls
   * this every two seconds, so it must never reach the database: doing that
   * starved the store's connection pool and left dispatch Jobs leased forever.
   * Adoption pays for one query at startup instead.
   */
  const viewerCache = new Map<string, { projectId: string; viewerUrl: string }>();
  const state: RegistryState = { resolveSql, dockerBinary, cache, viewerCache };
  return {
    diagnostic,
    get: (activityId) => cache.get(activityId),
    evict: (activityId) => void cache.delete(activityId),
    resolve: (activityId, projectId) => resolve(state, activityId, projectId),
    remember: (input) => remember(state, input),
    forget: (activityId, reason) => forget(state, activityId, reason),
    rememberViewer: (input) => rememberViewer(state, input),
    resolveViewer: (projectId, runId) => resolveViewer(state, projectId, runId),
    forgetViewer: (runId, reason) => forgetViewer(state, runId, reason),
    listOpen: () => listOpen(state),
    sweep: () => sweep(state),
  };
}

function diagnostic(
  event: string,
  fields: Record<string, string | number | boolean | null>,
): void {
  process.stderr.write(`[shipbash-inline-auth] ${JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...fields,
  })}\n`);
}

async function resolve(
  state: RegistryState,
  activityId: string,
  projectId?: string,
): Promise<InlineActivitySession | undefined> {
  const { cache } = state;
  // Deliberately cache-only. Every takeover read path is polled, and a
  // database round trip per poll starved the store's connection pool badly
  // enough to leave dispatch Jobs leased forever. The durable table is read
  // by the sweep -- at boot and every 30s -- which re-seeds this cache, so a
  // session that outlived the process is adopted there rather than here.
  const cached = cache.get(activityId);
  if (!cached) return undefined;
  return projectId === undefined || cached.projectId === projectId ? cached : undefined;
}

async function remember(
  state: RegistryState,
  { teamId, activityId, session, phase }: Parameters<InlineActivitySessionRegistry["remember"]>[0],
): Promise<void> {
  const { cache, resolveSql } = state;
  cache.set(activityId, session);
  const sql = resolveSql();
  if (!sql) return;
  // A registry write must never take down an otherwise healthy run. An
  // unregistered container reads as garbage to the reconciler.
  await openRuntimeSession(sql, {
    teamId,
    projectId: session.projectId,
    sourceKind: "activity",
    sourceId: activityId,
    containerName: session.containerName,
    controlDirectory: session.controlDirectory,
    authViewerUrl: session.authViewerUrl,
    ...(phase ? { phase } : {}),
  }).catch((error: unknown) => {
    diagnostic("session_registry_write_failed", {
      activityId,
      projectId: session.projectId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

async function forget(state: RegistryState, activityId: string, reason: string): Promise<void> {
  const { cache, resolveSql } = state;
  cache.delete(activityId);
  const sql = resolveSql();
  if (!sql) return;
  await closeRuntimeSession(sql, { sourceKind: "activity", sourceId: activityId }, reason)
    .catch(() => undefined);
}

async function rememberViewer(
  state: RegistryState,
  { teamId, projectId, runId, containerName, viewerUrl }: Parameters<
    InlineActivitySessionRegistry["rememberViewer"]
  >[0],
): Promise<void> {
  const { viewerCache, resolveSql } = state;
  viewerCache.set(runId, { projectId, viewerUrl });
  const sql = resolveSql();
  if (!sql) return;
  await openRuntimeSession(sql, {
    teamId,
    projectId,
    sourceKind: "suite_run",
    sourceId: runId,
    containerName,
    authViewerUrl: viewerUrl,
    phase: "viewer",
  }).catch((error: unknown) => {
    diagnostic("viewer_registry_write_failed", {
      runId,
      projectId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

async function resolveViewer(
  state: RegistryState,
  projectId: string,
  runId: string,
): Promise<string | null> {
  const { viewerCache } = state;
  const adopted = viewerCache.get(runId);
  return adopted && adopted.projectId === projectId ? adopted.viewerUrl : null;
}

async function forgetViewer(state: RegistryState, runId: string, reason: string): Promise<void> {
  const { viewerCache, resolveSql } = state;
  viewerCache.delete(runId);
  const sql = resolveSql();
  if (!sql) return;
  await closeRuntimeSession(sql, { sourceKind: "suite_run", sourceId: runId }, reason)
    .catch(() => undefined);
}

async function listOpen(state: RegistryState): Promise<RuntimeSessionRecord[]> {
  const sql = state.resolveSql();
  if (!sql) return [];
  return listOpenRuntimeSessions(sql).catch(() => []);
}

async function sweep(state: RegistryState): Promise<string[]> {
  const { resolveSql, dockerBinary, cache, viewerCache } = state;
  const sql = resolveSql();
  if (!sql) return [];
  try {
    const open = await listOpenRuntimeSessions(sql);
    if (open.length === 0) return [];
    // Docker is asked once for the whole set. If it cannot be reached this
    // throws, and the catch below terminalizes nothing: an unreachable
    // daemon is not evidence that anyone's browser died.
    const running = await listRunningManagedContainerNames(dockerBinary);
    const { alive, dead } = classifyRuntimeSessions(open, running, Date.now());
    for (const session of alive) {
      // Re-register the survivors so takeover keeps working across the
      // restart without any read path having to touch the database again.
      if (session.sourceKind === "suite_run" && session.authViewerUrl) {
        viewerCache.set(session.sourceId, {
          projectId: session.projectId,
          viewerUrl: session.authViewerUrl,
        });
      } else if (
        session.sourceKind === "activity" && session.controlDirectory && session.authViewerUrl
      ) {
        cache.set(session.sourceId, {
          projectId: session.projectId,
          controlDirectory: session.controlDirectory,
          authViewerUrl: session.authViewerUrl,
          containerName: session.containerName,
        });
      }
    }
    if (dead.length > 0) {
      for (const session of dead) {
        // Drop the stale entry first, so no takeover request can be handed a
        // viewer URL pointing at a container that no longer exists.
        if (session.sourceKind === "activity") cache.delete(session.sourceId);
        else viewerCache.delete(session.sourceId);
        diagnostic("session_container_lost", {
          sourceKind: session.sourceKind,
          sourceId: session.sourceId,
          projectId: session.projectId,
          containerName: session.containerName,
        });
      }
      const ended = await terminalizeWaitingWorkForDeadSessions(
        sql,
        dead.map((session) => session.id),
        RUNTIME_SESSION_DEAD_REASON,
      );
      for (const session of ended) {
        diagnostic("waiting_work_terminalized", { activityId: session.sourceId });
      }
    }
    return alive.map((session) => session.containerName);
  } catch (error) {
    diagnostic("session_liveness_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
