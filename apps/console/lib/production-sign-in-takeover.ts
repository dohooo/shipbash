import "server-only";

/**
 * Signing in to the product by hand on the hosted console, with no Activity
 * behind it: a browser in a Sandbox made for the Project, driven from the
 * same canvas an Activity takeover uses, its session captured when the person
 * says they are done and sealed on the Project's profile.
 *
 * The docker service keeps this browser on the laptop and proves the session
 * with a verification leg before the way in ticks. No such leg exists here —
 * the console has no browser of its own to prove with — so "I'm done" saves
 * what the person signed in to and ticks the way in at once, exactly as the
 * sign-in handoff does for a waiting run. Checking a saved password again is
 * the one leg this console runs (production-sign-in-check.ts); asked to check
 * any other saved way in again, it answers 503.
 */
import type { SignInTakeoverGateway, SignInVerificationGateway } from "@shipbash/control-plane/api";
import { authStateVersion } from "@shipbash/control-plane/init-browser-auth-state";
import { HttpError } from "@shipbash/control-plane/service/http-input";
import { providerSignInUrl } from "@shipbash/control-plane/service/provider-sign-in";
import { createRunSignInChoice, resumeRunsWaitingForSignIn } from "@shipbash/control-plane/service/run-sign-in-choice";
import {
  createSignInRecheck,
  type SignInVerificationContext,
  type SignInVerificationStore,
  takeoverRow,
} from "@shipbash/control-plane/service/sign-in-verification";
import type { SignInTakeover, SignInTakeoverAccess } from "@shipbash/control-plane/store/sign-in-takeovers";
import type { TargetAuthStateAccess } from "@shipbash/control-plane/store/target-auth-state";
import type { TeamSignIn } from "@shipbash/control-plane/store/team-sign-ins";
import type { TenantActor } from "@shipbash/control-plane/types";
import { hostedConfiguration } from "@shipbash/control-plane/configuration";
import type { RuntimeBundle } from "@shipbash/control-plane/vercel-sandbox-dispatch/runtime-bundle";

import type { ProductionHumanAuthSandboxFactory } from "./production-human-auth-sandbox";
import {
  discardSlotSandbox,
  liveSandbox,
  resolveSandboxDependencies,
  slotClaimIsFresh,
  type ResolvedSandboxDependencies,
} from "./production-sandbox-slot";
import { createProductionSignInVerifyLane } from "./production-sign-in-check";
import {
  captureTakeoverSession,
  mintToken,
  openTakeoverBrowser,
  SIGN_IN_TAKEOVER_TIMEOUT_MS,
} from "./production-sign-in-takeover-browser";

interface ProductionSignInTakeoverDependencies {
  store: SignInVerificationStore;
  /** Where the Project's sign-in is kept: what the browser continues from, and where the capture goes. */
  authState: Pick<TargetAuthStateAccess, "readForProject" | "saveForProject">;
  /** The Project's one takeover at a time. */
  takeovers: SignInTakeoverAccess;
  /** The console's origin: the only Origin the Sandbox's stream accepts a viewer from. */
  publicOrigin: string;
  /** Keeps a password check being settled alive past the request that started it: `after`, on Vercel. */
  background: (task: Promise<void>) => void;
  /** Dispatches the runs a way in turning ready put back on the queue. */
  onWorkAvailable: () => void | Promise<void>;
  sandboxFactory?: ProductionHumanAuthSandboxFactory;
  /** The runner image every takeover Sandbox is created from; SHIPBASH_RUNNER_IMAGE otherwise. */
  runnerImage?: string;
  /** The release's code layer; null runs the code the image booted with. */
  runtimeBundle?: RuntimeBundle | null;
  streamToken?: () => string;
}

type Resolved = ResolvedSandboxDependencies<ProductionSignInTakeoverDependencies>;

interface Scope {
  actor: TenantActor;
  teamId: string;
  projectId: string;
}

/** How long a second request waits for a claim another Function is bringing up. */
const JOIN_WAIT_MS = 30_000;
const JOIN_POLL_MS = 1_000;

/** Ends a takeover for good: its Sandbox, if it ever had one, and its row. */
async function endTakeover(resolved: Resolved, takeover: SignInTakeover): Promise<void> {
  await discardSlotSandbox(resolved.factory, takeover);
  await resolved.dependencies.takeovers.release(takeover.projectId);
}

/** A browser opened on the page this request wants, or on any page when the request names none. */
function sameSite(open: string | null, wanted: string | null): boolean {
  if (!wanted) return true;
  return open !== null && new URL(open).origin === new URL(wanted).origin;
}

/** The browser another request is opening, once it answers; null when it does not in time. */
async function awaitBrowser(resolved: Resolved, projectId: string): Promise<SignInTakeover | null> {
  const deadline = Date.now() + JOIN_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((settle) => setTimeout(settle, JOIN_POLL_MS));
    const takeover = await resolved.dependencies.takeovers.read(projectId);
    if (!takeover) return null;
    if (takeover.sandboxName !== null) return await liveSandbox(resolved.factory, takeover) ? takeover : null;
  }
  return null;
}

/**
 * The Project's running takeover to join, on the page this request wants:
 * the grant it already holds. A browser on another provider's page, or one
 * that died, is let go so a fresh one opens; a claim another Function is
 * still bringing up is waited for.
 */
async function joinTakeover(resolved: Resolved, projectId: string, startUrl: string | null): Promise<SignInTakeover | null> {
  const existing = await resolved.dependencies.takeovers.read(projectId);
  if (!existing) return null;
  const live = await liveSandbox(resolved.factory, existing);
  if (live) {
    if (sameSite(existing.startUrl, startUrl)) return existing;
    await endTakeover(resolved, existing);
    return null;
  }
  if (slotClaimIsFresh(existing)) {
    const opened = await awaitBrowser(resolved, projectId);
    if (opened && sameSite(opened.startUrl, startUrl)) return opened;
    throw new HttpError(409, "SIGN_IN_TAKEOVER_BUSY", "Another sign-in browser is opening for this Project; try again in a moment.");
  }
  console.warn("[shipbash:sign-in-takeover] Taking over a dead sign-in browser.", { projectId });
  await endTakeover(resolved, existing);
  return null;
}

async function takeover(
  resolved: Resolved,
  input: Scope & { method: Parameters<SignInTakeoverGateway["takeover"]>[0]["method"] },
): Promise<{ streamUrl: string; controlToken: string }> {
  const { dependencies, factory } = resolved;
  const { actor, teamId, projectId } = input;
  const productionUrl = (await dependencies.store.getProject(actor, teamId, projectId))?.productionUrl ?? null;
  // A third-party way in is signed in to at the provider itself; the product's own doors open on the product.
  const startUrl = providerSignInUrl(input.method) ?? productionUrl;
  const joined = await joinTakeover(resolved, projectId, startUrl);
  if (joined?.streamUrl) return { streamUrl: joined.streamUrl, controlToken: joined.controlToken };
  const controlToken = mintToken();
  if (!await dependencies.takeovers.claim({ teamId, projectId, controlToken, startUrl })) {
    throw new HttpError(409, "SIGN_IN_TAKEOVER_BUSY", "Another sign-in browser is opening for this Project; try again in a moment.");
  }
  try {
    const browser = await openTakeoverBrowser(factory, {
      projectId,
      image: dependencies.runnerImage ?? hostedConfiguration().hosted.runnerImage,
      runtimeBundle: resolved.runtimeBundle,
      timeoutMs: SIGN_IN_TAKEOVER_TIMEOUT_MS,
      savedState: productionUrl ? await dependencies.authState.readForProject(teamId, projectId, productionUrl) : null,
      controlToken,
      startUrl,
      streamToken: (dependencies.streamToken ?? mintToken)(),
      allowedOrigin: dependencies.publicOrigin,
    });
    await dependencies.takeovers.attachBrowser(projectId, {
      sandboxName: browser.sandbox.name,
      commandId: browser.commandId,
      streamUrl: browser.streamUrl,
    });
    return { streamUrl: browser.streamUrl, controlToken };
  } catch (error) {
    await dependencies.takeovers.release(projectId).catch(() => undefined);
    throw error;
  }
}

async function release(resolved: Resolved, projectId: string): Promise<void> {
  const existing = await resolved.dependencies.takeovers.read(projectId);
  if (existing) await endTakeover(resolved, existing);
}

/**
 * "I'm done": the way in saved for the Team as ready and bound to this
 * Project, on a new row or on the saved one the person signed in to again, and
 * the session the person made sealed on the Project's profile
 * when runs sign in with this way in — the first one the Project saves, or the
 * one they already use, whose runs parked on a sign-in then resume. The
 * browser has done its job whichever way the save went, so the Sandbox goes.
 */
async function complete(
  resolved: Resolved,
  input: Parameters<SignInVerificationGateway["complete"]>[0],
): Promise<TeamSignIn> {
  const { dependencies, factory } = resolved;
  const { actor, teamId, projectId } = input;
  const productionUrl = (await dependencies.store.getProject(actor, teamId, projectId))?.productionUrl;
  if (!productionUrl) {
    throw new HttpError(409, "PRODUCTION_URL_REQUIRED", "This Project has no Production URL, so there is nowhere to keep the sign-in for.");
  }
  const existing = await dependencies.takeovers.read(projectId);
  const sandbox = existing && await liveSandbox(factory, existing);
  if (!existing || !sandbox) {
    throw new HttpError(409, "SIGN_IN_TAKEOVER_GONE", "The sign-in browser is no longer open, so there is no session to save.");
  }
  let session: Buffer;
  let githubAccountLogin: string | null;
  try {
    const captured = await captureTakeoverSession(sandbox);
    session = Buffer.from(JSON.stringify(captured.state));
    githubAccountLogin = captured.githubAccountLogin;
  } finally {
    await endTakeover(resolved, existing);
  }
  const target = await takeoverRow(dependencies.store, input);
  // A ready way in carries the session it was ticked on (team_sign_ins_ready_check).
  // The Sandbox's key died with it, so the row keeps the state itself — sealed
  // at rest by the Team keyring like everything on it — named by its own bytes,
  // with the GitHub account its cookies name.
  const signIn = await dependencies.store.updateTeamSignIn(actor, teamId, target.id, {
    status: "ready",
    failureReason: null,
    consecutiveFailures: 0,
    session: {
      state: session.toString("base64"),
      version: authStateVersion(session),
      githubAccountLogin,
    },
  }) ?? target;
  await dependencies.store.bindProjectSignIn(actor, teamId, projectId, signIn.id);
  await dependencies.store.recordTeamSignInEvent(actor, teamId, { signInId: signIn.id, projectId, actor: "user", action: "saved" });
  if (await dependencies.store.claimProjectRunSignIn(actor, teamId, projectId, signIn.id)) {
    await dependencies.authState.saveForProject(teamId, projectId, productionUrl, session.toString("utf8"));
    await resumeRunsWaitingForSignIn(dependencies, { actor, teamId, signInId: signIn.id });
  }
  return signIn;
}

/** A way in's session as the Project's profile keeps it: the state itself, sealed by the Team keyring at rest. */
function promoteToProfile(dependencies: ProductionSignInTakeoverDependencies): SignInVerificationContext["promote"] {
  return async ({ teamId, projectId, productionUrl, sealedState }) => {
    await dependencies.authState.saveForProject(teamId, projectId, productionUrl, sealedState.toString("utf8"));
    return "promoted";
  };
}

/**
 * "Check this one again". A saved password is typed in once more by the
 * auto-login leg in a Sandbox of its own, and the session it makes is kept
 * the way `complete` keeps a capture. Every other way in has no leg here —
 * it ticked when it was saved — so it answers 503 before any row moves.
 */
function recheckPassword(dependencies: ProductionSignInTakeoverDependencies): SignInVerificationGateway["verify"] {
  const recheck = createSignInRecheck({
    store: dependencies.store,
    verify: createProductionSignInVerifyLane(async () => {
      const { factory, runtimeBundle } = await resolveSandboxDependencies(dependencies);
      const image = dependencies.runnerImage ?? hostedConfiguration().hosted.runnerImage;
      return { factory, runtimeBundle, image, publicOrigin: dependencies.publicOrigin };
    }),
    // The lane hands back the state itself, which is what the profile keeps.
    promote: promoteToProfile(dependencies),
    background: dependencies.background,
    onWorkAvailable: dependencies.onWorkAvailable,
  });
  return async (input) => {
    const signIn = (await dependencies.store.listProjectSignIns(input.actor, input.teamId, input.projectId))
      .find((candidate) => candidate.id === input.signInId);
    if (signIn && signIn.method !== "email_password") {
      throw new HttpError(503, "SIGN_IN_VERIFICATION_UNAVAILABLE", "Checking a saved sign-in again is not available here.");
    }
    return recheck(input);
  };
}

export function createProductionSignInGateways(
  dependencies: ProductionSignInTakeoverDependencies,
): { takeover: SignInTakeoverGateway; verification: SignInVerificationGateway } {
  return {
    takeover: {
      takeover: async (input) => takeover(await resolveSandboxDependencies(dependencies), input),
      release: async ({ projectId }) => release(await resolveSandboxDependencies(dependencies), projectId),
    },
    verification: {
      complete: async (input) => complete(await resolveSandboxDependencies(dependencies), input),
      verify: recheckPassword(dependencies),
      streamUrl: () => null,
      chooseForRuns: createRunSignInChoice({
        store: dependencies.store,
        promote: promoteToProfile(dependencies),
        onWorkAvailable: dependencies.onWorkAvailable,
      }),
    },
  };
}
