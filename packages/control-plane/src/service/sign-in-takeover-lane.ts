/**
 * The sign-in takeover lane: one browser per Project that a person drives by
 * hand, with no Activity behind it.
 *
 * The Project owns the browser, not the caller — a second takeover call for
 * the same Project joins the one that is already up and gets the same lease
 * token, exactly as the Activity lease is stable across repeated status
 * polls. That is the single-owner rule: never two Chromiums for one Project,
 * and never a second lease that would invalidate an open control channel.
 *
 * Two clocks end a session. The container's own idle tracker exits it ten
 * minutes after the last stream viewer leaves, and this lane arms a host-side
 * ceiling that releases whatever is still standing. Every takeover call
 * re-arms that ceiling, so a page that keeps asking keeps its browser.
 */
import { join } from "node:path";

import type { SignInTakeoverGrant } from "@shipbash/contracts/api/sign-in-takeover";

import {
  type SignInTakeoverContainer,
  type SignInTakeoverContainerInput,
  signInTakeoverContainerName,
  signInTakeoverStreamUrl,
  startSignInTakeoverContainer,
  stopSignInTakeoverContainer,
  readSignInBrowserEndpoint,
  navigateSignInBrowser,
} from "../init-browser-control.ts";
import {
  type CapturedSignInSession,
  captureSignInSession,
} from "../sign-in-capture.ts";
import {
  clearSignInControlLease,
  ensureSignInControlLease,
} from "../sign-in-control-lease.ts";
import { HttpError } from "./http-input.ts";
import { projectAuthDirectoryFor, projectStateDirectoryFor } from "./runtime-glue.ts";

/** How long a takeover survives without another takeover call re-arming it. */
export const SIGN_IN_TAKEOVER_IDLE_MS = 15 * 60_000;

/** The Docker-facing half, injected so the lane's rules are testable without Docker. */
export interface SignInTakeoverContainerLane {
  start(input: SignInTakeoverContainerInput): Promise<SignInTakeoverContainer>;
  streamUrl(dockerBinary: string, containerName: string): Promise<string | null>;
  stop(dockerBinary: string, containerName: string): Promise<void>;
}

export interface SignInTakeoverLaneContext {
  shipbashDirectory: string;
  dockerBinary(): string;
  runnerImage: string;
  /** The Project hash the container sweep knows this Project by. */
  projectHash(projectId: string): string;
  isShuttingDown(): boolean;
  ensureImage(dockerBinary: string): Promise<void>;
  containers?: SignInTakeoverContainerLane;
  readEndpoint?: typeof readSignInBrowserEndpoint;
  navigate?: typeof navigateSignInBrowser;
}

export interface SignInTakeoverLane {
  borrow(projectId: string, startUrl: string): Promise<SignInBrowserLease>;
  /** `startUrl` is the page the browser opens on, usually the Project's Production URL. */
  takeover(projectId: string, startUrl: string | null): Promise<SignInTakeoverGrant>;
  /**
   * The session the person just made, sealed under the Project's browser key.
   * Refuses when no takeover is up: a capture with no browser behind it would
   * answer with whatever an earlier one left on the mount.
   */
  capture(projectId: string): Promise<CapturedSignInSession>;
  release(projectId: string): Promise<void>;
}

export interface SignInBrowserLease {
  reused: boolean;
  containerId: string;
  cdpUrl: string;
  streamUrl: string;
  release(): Promise<void>;
}

interface TakeoverSession {
  startUrl: string | null;
  containerName: string;
  controlDirectory: string;
  streamUrl: string;
  expiry: ReturnType<typeof setTimeout>;
  checking?: boolean;
}

const DEFAULT_CONTAINERS: SignInTakeoverContainerLane = {
  start: startSignInTakeoverContainer,
  streamUrl: signInTakeoverStreamUrl,
  stop: stopSignInTakeoverContainer,
};

function controlDirectoryFor(shipbashDirectory: string, projectId: string): string {
  return join(projectStateDirectoryFor(shipbashDirectory, projectId), "sign-in-control");
}

/** The capture, once a live session has been found for the Project. */
async function captureFrom(
  shipbashDirectory: string,
  projectId: string,
  session: TakeoverSession | null,
): Promise<CapturedSignInSession> {
  if (!session) {
    throw new HttpError(
      409,
      "SIGN_IN_TAKEOVER_GONE",
      "The sign-in browser is no longer open, so there is no session to save.",
    );
  }
  if (session.checking) {
    throw new HttpError(409, "SIGN_IN_CHECK_IN_PROGRESS", "Wait for the sign-in check to finish before saving this session.");
  }
  return captureSignInSession({
    controlDirectory: session.controlDirectory,
    authDirectory: projectAuthDirectoryFor(shipbashDirectory, projectId),
  });
}

async function selectSignInSite(context: SignInTakeoverLaneContext, session: TakeoverSession, startUrl: string | null) {
  if (session.checking) throw new HttpError(409, "SIGN_IN_CHECK_IN_PROGRESS", "The agent is checking this sign-in. Wait for it to finish.");
  if (!startUrl || (session.startUrl && new URL(session.startUrl).origin === new URL(startUrl).origin)) return;
  await (context.navigate ?? navigateSignInBrowser)(context.dockerBinary(), session.containerName, startUrl);
  session.startUrl = startUrl;
}

async function borrowSession(context: SignInTakeoverLaneContext, session: TakeoverSession | undefined, onRelease: () => void, reused: boolean): Promise<SignInBrowserLease> {
  if (!session || session.checking) throw new HttpError(409, "SIGN_IN_CHECK_IN_PROGRESS", "The sign-in browser is unavailable or already being checked.");
  session.checking = true;
  clearTimeout(session.expiry);
  const release = async () => { session.checking = false; onRelease(); };
  try {
    await clearSignInControlLease(session.controlDirectory);
    const endpoint = await (context.readEndpoint ?? readSignInBrowserEndpoint)(context.dockerBinary(), session.containerName);
    return { ...endpoint, streamUrl: session.streamUrl, release, reused };
  } catch (error) {
    await release();
    throw error;
  }
}

async function borrowProjectBrowser(
  context: SignInTakeoverLaneContext,
  lane: SignInTakeoverLane,
  sessions: Map<string, TakeoverSession>,
  arm: (projectId: string, session: TakeoverSession) => void,
  projectId: string,
  startUrl: string,
): Promise<SignInBrowserLease> {
  const previous = sessions.get(projectId);
  await lane.takeover(projectId, startUrl);
  const session = sessions.get(projectId);
  return borrowSession(context, session, () => {
    if (session && sessions.get(projectId) === session) arm(projectId, session);
  }, previous === session);
}

export function createSignInTakeoverLane(context: SignInTakeoverLaneContext): SignInTakeoverLane {
  const containers = context.containers ?? DEFAULT_CONTAINERS;
  const sessions = new Map<string, TakeoverSession>();
  const starts = new Map<string, Promise<SignInTakeoverGrant>>();

  async function tearDown(projectId: string, session: TakeoverSession): Promise<void> {
    clearTimeout(session.expiry);
    sessions.delete(projectId);
    await clearSignInControlLease(session.controlDirectory).catch(() => undefined);
    await containers.stop(context.dockerBinary(), session.containerName).catch(() => undefined);
  }

  function arm(projectId: string, session: TakeoverSession): void {
    clearTimeout(session.expiry);
    session.expiry = setTimeout(() => {
      void tearDown(projectId, session);
    }, SIGN_IN_TAKEOVER_IDLE_MS);
    // The ceiling must never be the reason the process stays alive.
    session.expiry.unref?.();
  }

  /** The live session for this Project, after checking its container is still there. */
  async function joinable(projectId: string): Promise<TakeoverSession | null> {
    const session = sessions.get(projectId);
    if (!session) return null;
    const streamUrl = await containers.streamUrl(context.dockerBinary(), session.containerName);
    if (streamUrl === null) {
      await tearDown(projectId, session);
      return null;
    }
    session.streamUrl = streamUrl;
    if (!session.checking) arm(projectId, session);
    return session;
  }

  async function startSession(projectId: string, startUrl: string | null): Promise<SignInTakeoverGrant> {
    const dockerBinary = context.dockerBinary();
    const controlDirectory = controlDirectoryFor(context.shipbashDirectory, projectId);
    const controlToken = await ensureSignInControlLease(controlDirectory);
    await context.ensureImage(dockerBinary);
    const stateDirectory = projectStateDirectoryFor(context.shipbashDirectory, projectId);
    const container = await containers.start({
      dockerBinary,
      image: context.runnerImage,
      projectId,
      projectHash: context.projectHash(projectId),
      stateDirectory,
      authDirectory: projectAuthDirectoryFor(context.shipbashDirectory, projectId),
      controlDirectory,
      startUrl,
    }).catch(async (error: unknown) => {
      // A lease with no browser behind it would grant control of nothing.
      await clearSignInControlLease(controlDirectory).catch(() => undefined);
      throw error;
    });
    const session: TakeoverSession = {
      startUrl,
      containerName: container.name,
      controlDirectory,
      streamUrl: container.streamUrl,
      expiry: setTimeout(() => undefined, 0),
    };
    sessions.set(projectId, session);
    arm(projectId, session);
    return { streamUrl: container.streamUrl, controlToken };
  }

  const lane: SignInTakeoverLane = {
    takeover: async (projectId, startUrl) => {
      if (context.isShuttingDown()) {
        throw new HttpError(503, "SERVICE_SHUTTING_DOWN", "ShipBash is shutting down.");
      }
      const inFlight = starts.get(projectId);
      if (inFlight) return inFlight;
      const joined = await joinable(projectId);
      if (joined) {
        await selectSignInSite(context, joined, startUrl);
        return {
          streamUrl: joined.streamUrl,
          controlToken: await ensureSignInControlLease(joined.controlDirectory),
        };
      }
      const promise = startSession(projectId, startUrl).finally(() => {
        if (starts.get(projectId) === promise) starts.delete(projectId);
      });
      starts.set(projectId, promise);
      return promise;
    },
    capture: async (projectId) =>
      captureFrom(context.shipbashDirectory, projectId, await joinable(projectId)),
    borrow: (projectId, startUrl) =>
      borrowProjectBrowser(context, lane, sessions, arm, projectId, startUrl),
    release: async (projectId) => {
      const session = sessions.get(projectId);
      if (session) {
        await tearDown(projectId, session);
        return;
      }
      // Nothing in memory: a container stranded by an earlier service life is
      // still this Project's, and its lease is still on disk. Both go.
      await clearSignInControlLease(controlDirectoryFor(context.shipbashDirectory, projectId))
        .catch(() => undefined);
      await containers
        .stop(context.dockerBinary(), signInTakeoverContainerName(projectId))
        .catch(() => undefined);
    },
  };
  return lane;
}
