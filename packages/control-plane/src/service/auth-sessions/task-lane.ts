/**
 * The task authentication lanes: one takeover container per Run or Activity,
 * guarded by the handoff ownership table so a Project can only ever hold one.
 *
 * The ownership claim comes before the container: acquire() either wins the
 * Project's single slot (stopping whatever held it) or answers busy, and a
 * failed start releases the claim rather than stranding it.
 */
import type { HumanAuthSession } from "../../human-auth.ts";
import type { ApiOptions } from "../../api.ts";
import {
  resolveDispatchTrustedAccess,
  type TrustedAccessRuntimeConfig,
} from "../../trusted-access-runtime.ts";
import { stopAuthHandoff } from "../auth-handoff-ownership.ts";
import type { AuthSessionContext, AuthSessions } from "../auth-sessions.ts";
import { HttpError } from "../http-input.ts";
import { taskAuthDirectoryFor, taskStateDirectoryFor } from "../runtime-glue.ts";
import { authLandingUrl, taskAuthSessionId, type AuthSessionState } from "./state.ts";

type TaskAuthLane = Pick<
  AuthSessions,
  | "resolveTrustedAccess"
  | "startTaskAuthSession"
  | "stopTaskAuthSession"
  | "requireActivityAwaitingAuth"
>;

type StartTaskAuthInput = Parameters<AuthSessions["startTaskAuthSession"]>[0];

async function resolveTrustedAccess(
  context: AuthSessionContext,
  teamId: string,
  projectId: string,
  productionUrl: string,
): Promise<TrustedAccessRuntimeConfig | undefined> {
  const { tenantStore } = context;
  if (!tenantStore) return undefined;
  return resolveDispatchTrustedAccess({
    internal: tenantStore.internal,
    scope: { teamId, projectId },
    productionUrl,
  });
}

/**
 * Claims the Project's single handoff slot, then starts the container the
 * claim entitles it to. A start that fails releases the claim, and only a Run
 * takeover publishes its viewer to the inline activity registry.
 */
async function startTaskAuthSession(
  context: AuthSessionContext,
  state: AuthSessionState,
  input: StartTaskAuthInput,
): Promise<HumanAuthSession> {
  const {
    deps,
    tenantStore,
    inlineActivityAuthSessions,
    ownership: taskAuthOwners,
    shipbashDirectory,
    trackProjectHash,
    dockerBinaryOption,
  } = context;
  if (context.isShuttingDown()) {
    throw new HttpError(503, "SERVICE_SHUTTING_DOWN", "ShipBash is shutting down.");
  }
  const sessionId = taskAuthSessionId(input.projectId, input.targetKind, input.targetId);
  const existing = state.sessions.get(sessionId);
  if (existing) return existing;
  const inFlight = state.starts.get(sessionId);
  if (inFlight) return inFlight;
  const granted = await taskAuthOwners.acquire({
    claim: { projectId: input.projectId, targetKind: input.targetKind, targetId: input.targetId },
    sessionId,
    sql: tenantStore ? tenantStore.internal.runtimeSessionsSql() : null,
    stop: (holder) => stopTaskAuthSession(
      context, state, input.projectId, holder.sessionId, holder.targetKind, holder.targetId,
    ),
  });
  if (granted === "busy") {
    throw new HttpError(
      409,
      "AUTH_HANDOFF_BUSY",
      "Finish the current Project authentication handoff before starting another one.",
    );
  }
  const stateDirectory = taskStateDirectoryFor(
    shipbashDirectory,
    input.projectId,
    input.targetKind,
    input.targetId,
  );
  const authDirectory = taskAuthDirectoryFor(
    shipbashDirectory,
    input.projectId,
    input.targetKind,
    input.targetId,
  );
  const trustedAccess = await resolveTrustedAccess(
    context,
    input.teamId,
    input.projectId,
    authLandingUrl(input.productionUrl),
  );
  const promise: Promise<HumanAuthSession> = deps.startHumanAuthSession({
    sessionId,
    projectHash: trackProjectHash(input.projectId),
    stateDirectory,
    authDirectory,
    productionUrl: authLandingUrl(input.productionUrl),
    ...(trustedAccess ? { trustedAccess } : {}),
    ...(input.preloadRefusedCandidate ? { preloadRefusedCandidate: true } : {}),
    ...dockerBinaryOption(),
  }).then(async (session) => {
    state.sessions.set(sessionId, session);
    if (input.targetKind === "run") await inlineActivityAuthSessions.rememberViewer({ teamId: input.teamId, projectId: input.projectId, runId: input.targetId, containerName: session.containerName, viewerUrl: session.viewerUrl });
    return session;
  }).catch((error) => {
    taskAuthOwners.release(input.projectId);
    throw error;
  }).finally(() => {
    if (state.starts.get(sessionId) === promise) state.starts.delete(sessionId);
  });
  state.starts.set(sessionId, promise);
  return promise;
}

async function stopTaskAuthSession(
  context: AuthSessionContext,
  state: AuthSessionState,
  projectId: string,
  sessionId: string,
  targetKind: "run" | "activity",
  targetId: string,
): Promise<void> {
  const { deps, inlineActivityAuthSessions, shipbashDirectory, dockerBinaryOption } = context;
  return stopAuthHandoff({
    sessionId, projectId, targetKind, targetId,
    sessions: state.sessions,
    starts: state.starts,
    ownership: context.ownership,
    paths: (kind, id) => ({
      stateDirectory: taskStateDirectoryFor(shipbashDirectory, projectId, kind, id),
      authDirectory: taskAuthDirectoryFor(shipbashDirectory, projectId, kind, id),
    }),
    stopSession: (id, paths) => deps.stopHumanAuthSession(id, { ...paths, ...dockerBinaryOption() }),
    forgetViewer: (id) => inlineActivityAuthSessions
      .forgetViewer(id, "Authentication handoff viewer stopped."),
  });
}

// A takeover may open a container of its own only for an Activity that is
// genuinely parked waiting for one. Everything else keeps the door shut.
async function requireActivityAwaitingAuth(
  context: AuthSessionContext,
  input: Parameters<NonNullable<ApiOptions["auth"]>["status"]>[0],
): Promise<void> {
  const { tenantStore } = context;
  if (!tenantStore) return;
  const status = await tenantStore.actor.getActivityStatus(
    input.actor, input.teamId, input.projectId, input.targetId,
  );
  if (status !== "waiting_for_auth") {
    throw new HttpError(
      409,
      "AUTH_HANDOFF_NOT_READY",
      "The current Activity browser is not ready for takeover yet.",
    );
  }
}

export function createTaskAuthLane(
  context: AuthSessionContext,
  state: AuthSessionState,
): TaskAuthLane {
  return {
    resolveTrustedAccess: (teamId, projectId, productionUrl) =>
      resolveTrustedAccess(context, teamId, projectId, productionUrl),
    startTaskAuthSession: (input) => startTaskAuthSession(context, state, input),
    stopTaskAuthSession: (projectId, sessionId, targetKind, targetId) =>
      stopTaskAuthSession(context, state, projectId, sessionId, targetKind, targetId),
    requireActivityAwaitingAuth: (input) => requireActivityAwaitingAuth(context, input),
  };
}
