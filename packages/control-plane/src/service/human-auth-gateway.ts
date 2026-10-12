/**
 * The human-auth takeover gateway the API dispatcher plugs in.
 *
 * status opens (or joins) the dedicated sign-in container — or, for an
 * Activity paused on an open question, grants the control lease over its
 * own live browser —
 * upload feeds a file into an inline Activity browser, complete captures
 * the candidate and resumes the parked run — resuming is the same act as
 * finishing the sign-in, never a separate button — and
 * cancel signals whichever browser is actually holding the takeover.
 */
import { randomUUID } from "node:crypto";

import {
  clearActivityAuthControlLease,
  ensureActivityAuthControlLease,
  readActivityAuthControlLease,
  storeActivityAuthUpload,
  writeActivityAuthCancelSentinel,
  writeActivitySteerFile,
} from "../activity-control-files.ts";
import type { TenantStore } from "../store/tenant-store.ts";
import type { ApiOptions } from "../api.ts";
import type { AuthSessions } from "./auth-sessions.ts";
import { HttpError } from "./http-input.ts";
import { taskAuthDirectoryFor, taskStateDirectoryFor } from "./runtime-glue.ts";
import { shortDigest } from "./short-digest.ts";
import type { InlineActivitySessionRegistry } from "./runtime-session-registry.ts";
import { signInCaptureAnswer } from "./sign-in-capture-answer.ts";
import type { ServiceDependencies } from "./support.ts";

/** What the gateway borrows from the service closure. */
export interface HumanAuthGatewayContext {
  tenantStore: TenantStore;
  authSessions: AuthSessions;
  inlineActivityAuthSessions: InlineActivitySessionRegistry;
  deps: ServiceDependencies;
  shipbashDirectory: string;
  dockerBinaryOption(): { dockerBinary?: string };
  reconcileDispatchQueue(): Promise<void>;
}

interface TakeoverTarget {
  teamId: string;
  projectId: string;
  targetId: string;
}

/**
 * The lease-only takeover of a live Activity browser standing still on an
 * open question. Takeover
 * and handback speak through the steer seam — the reader's voice in the
 * running pass — so the agent yields at its next tool boundary and the
 * conversation keeps an honest record of who held the browser. The context
 * names exactly what it borrows.
 */
export function createLiveTakeoverLease(context: {
  tenantStore: {
    internal: {
      appendActivityEventInternal: (
        input: Parameters<TenantStore["internal"]["appendActivityEventInternal"]>[0],
      ) => Promise<unknown>;
    };
  };
  inlineActivityAuthSessions: Pick<InlineActivitySessionRegistry, "resolve">;
}) {
  const { tenantStore, inlineActivityAuthSessions } = context;

  async function steer(input: TakeoverTarget, controlDirectory: string, message: string): Promise<void> {
    const clientKey = `takeover-${randomUUID()}`;
    await tenantStore.internal.appendActivityEventInternal({
      teamId: input.teamId,
      projectId: input.projectId,
      activityId: input.targetId,
      kind: "goal",
      label: "Steer",
      bodyMarkdown: message,
      safeData: { event: "steer_requested", clientKey },
    });
    await writeActivitySteerFile(controlDirectory, { message, clientKey });
  }

  return {
    grant: async (input: TakeoverTarget): Promise<{ waiting: boolean; authViewerUrl: null; controlToken: string }> => {
      const session = await inlineActivityAuthSessions.resolve(input.targetId, input.projectId);
      if (!session) {
        throw new HttpError(
          409,
          "AUTH_HANDOFF_NOT_READY",
          "The current Activity browser is not ready for takeover yet.",
        );
      }
      const alreadyGranted = await readActivityAuthControlLease(session.controlDirectory) !== null;
      const controlToken = await ensureActivityAuthControlLease(session.controlDirectory);
      if (!alreadyGranted) {
        await steer(input, session.controlDirectory, "I've taken the browser — hold your actions until I hand it back.");
      }
      return { waiting: true, authViewerUrl: null, controlToken };
    },
    release: async (input: TakeoverTarget): Promise<void> => {
      const session = await inlineActivityAuthSessions.resolve(input.targetId, input.projectId);
      if (!session) return;
      if (await readActivityAuthControlLease(session.controlDirectory) === null) return;
      await clearActivityAuthControlLease(session.controlDirectory);
      await steer(input, session.controlDirectory, "Handing the browser back — continue.");
    },
  };
}

type CompleteInput = Parameters<NonNullable<ApiOptions["auth"]>["complete"]>[0];

/**
 * Finishing a parked sign-in: stop the viewer container, capture the
 * candidate it holds, and resume the run — the session just captured is what
 * lets the next round walk straight past the wall this one stopped at.
 */
async function captureAndResume(
  context: HumanAuthGatewayContext,
  input: CompleteInput,
): Promise<{ resumed: boolean }> {
  const { tenantStore, authSessions, deps, shipbashDirectory, dockerBinaryOption, reconcileDispatchQueue } = context;
  const sessionId = authSessions.taskAuthSessionId(input.projectId, input.targetKind, input.targetId);
  await authSessions.stopTaskAuthSession(
    input.projectId,
    sessionId,
    input.targetKind,
    input.targetId,
  );
  const landingUrl = authSessions.authLandingUrl(input.productionUrl);
  const trustedAccess = await authSessions.resolveTrustedAccess(input.teamId, input.projectId, landingUrl);
  try {
    await deps.captureHumanAuthCandidate({
      sessionId,
      projectHash: shortDigest(input.projectId),
      stateDirectory: taskStateDirectoryFor(shipbashDirectory, input.projectId, input.targetKind, input.targetId),
      authDirectory: taskAuthDirectoryFor(shipbashDirectory, input.projectId, input.targetKind, input.targetId),
      productionUrl: landingUrl,
      ...(trustedAccess ? { trustedAccess } : {}),
      ...dockerBinaryOption(),
    });
  } catch (error) {
    // The fresh viewer a refusal gets starts from the refused capture: the
    // identity provider's session in it spares the person that sign-in again.
    throw await signInCaptureAnswer(error, async () =>
      (await authSessions.startTaskAuthSession({ ...input, preloadRefusedCandidate: true })).viewerUrl);
  }
  if (input.targetKind === "activity") {
    await tenantStore.actor.resumeActivityAfterAuth(
      input.actor, input.teamId, input.projectId, input.targetId,
    );
    await reconcileDispatchQueue();
    return { resumed: true };
  }
  const resumed = await tenantStore.actor.resumeSuiteRunAfterAuth(
    input.actor, input.teamId, input.projectId, input.targetId,
  );
  if (resumed) await reconcileDispatchQueue();
  return { resumed };
}

type CancelInput = Parameters<NonNullable<ApiOptions["auth"]>["cancel"]>[0];

/** Cancels whichever browser actually holds the takeover. */
async function cancelTakeover(context: HumanAuthGatewayContext, input: CancelInput): Promise<void> {
  const { tenantStore, authSessions, inlineActivityAuthSessions } = context;
  if (input.targetKind === "activity") {
    const session = await inlineActivityAuthSessions.resolve(input.targetId, input.projectId);
    if (session) {
      await clearActivityAuthControlLease(session.controlDirectory).catch(() => undefined);
      await writeActivityAuthCancelSentinel(session.controlDirectory).catch(() => undefined);
      inlineActivityAuthSessions.diagnostic("cancel_signal_written", {
        activityId: input.targetId,
        projectId: input.projectId,
        containerName: session.containerName,
      });
      return;
    }
    // Nothing inline to signal: the sign-in container, if one was opened,
    // is the only thing left to close.
    await authSessions.stopTaskAuthSession(
      input.projectId,
      authSessions.taskAuthSessionId(input.projectId, input.targetKind, input.targetId),
      input.targetKind,
      input.targetId,
    ).catch(() => undefined);
    return;
  }
  await authSessions.stopTaskAuthSession(
    input.projectId,
    authSessions.taskAuthSessionId(input.projectId, input.targetKind, input.targetId),
    input.targetKind,
    input.targetId,
  ).catch(() => undefined);
  await tenantStore.actor.requestSuiteRunCancellation(
    input.actor, input.teamId, input.projectId, input.targetId,
  );
}

export function createHumanAuthGateway(
  context: HumanAuthGatewayContext,
): NonNullable<ApiOptions["auth"]> {
  const { tenantStore, authSessions, inlineActivityAuthSessions } = context;
  const { requireActivityAwaitingAuth, startTaskAuthSession, taskAuthSessionId } = authSessions;
  const humanAuthSessions = authSessions.sessions;
  const liveTakeover = createLiveTakeoverLease({ tenantStore, inlineActivityAuthSessions });

  return {
    status: async (input) => {
      if (input.targetKind === "activity" && input.activityLiveTakeover) {
        return liveTakeover.grant(input);
      }
      // A walk blocked on sign-in lets its runtime go rather than hold a
      // browser open for however long the owner takes, so by the time anyone
      // reaches for Take control there is nothing inline left to attach to.
      // Sign-in gets a container of its own, and the session it captures is
      // handed to the round that picks the walk back up.
      if (input.targetKind === "activity") await requireActivityAwaitingAuth(input);
      const session = await startTaskAuthSession(input);
      return { waiting: true, authViewerUrl: session.viewerUrl };
    },
    upload: async (input) => {
      if (input.targetKind !== "activity") {
        throw new HttpError(404, "AUTH_UPLOAD_UNAVAILABLE", "Takeover upload is unavailable.");
      }
      const session = await inlineActivityAuthSessions.resolve(input.targetId, input.projectId);
      if (!session) {
        throw new HttpError(
          409,
          "AUTH_HANDOFF_NOT_READY",
          "The current Activity browser is not ready for takeover yet.",
        );
      }
      const name = await storeActivityAuthUpload(
        session.controlDirectory,
        input.fileName,
        input.bytes,
      );
      return { name };
    },
    peek: async (input) => input.targetKind === "activity"
      ? (await inlineActivityAuthSessions.resolve(input.targetId, input.projectId))?.authViewerUrl ?? null
      : humanAuthSessions.get(
          taskAuthSessionId(input.projectId, input.targetKind, input.targetId),
        )?.viewerUrl ?? await inlineActivityAuthSessions.resolveViewer(input.projectId, input.targetId),
    complete: async (input) => {
      if (input.targetKind === "activity" && input.activityLiveTakeover) {
        // Nothing parked to resume: hand the wheel back and the pass carries on.
        await liveTakeover.release(input);
        return { resumed: true };
      }
      if (input.targetKind === "activity") await requireActivityAwaitingAuth(input);
      return captureAndResume(context, input);
    },
    cancel: async (input) => {
      if (input.targetKind === "activity" && input.activityLiveTakeover) {
        // Abandoning a live takeover only releases the lease — the run was
        // never waiting on sign-in, so there is no handoff to cancel.
        await liveTakeover.release(input);
        return;
      }
      await cancelTakeover(context, input);
    },
  };
}
