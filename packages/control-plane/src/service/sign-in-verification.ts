/**
 * Completes or rechecks a sign-in in the project's existing browser.
 * Completion checks the live session without reopening it; a saved account
 * check loads that account's own session. Only a successful verdict promotes
 * session data and marks the sign-in ready.
 */
import type { SignInVerificationGateway } from "../api/gateways.ts";
import type { ActorStore } from "../store/actor-store.ts";
import type { TeamSignIn } from "../store/team-sign-ins.ts";
import type { TenantActor } from "../types.ts";
import type { TeamSignInFailureReason } from "@shipbash/contracts/database-contract-types";
import { HttpError } from "./http-input.ts";
import { providerCheckUrl } from "./provider-sign-in.ts";
import { createRunSignInChoice, resumeRunsWaitingForSignIn } from "./run-sign-in-choice.ts";
import { signInFailureUpdate, signInResumeUpdate } from "./sign-in-pause.ts";
import type { SignInTakeoverLane } from "./sign-in-takeover-lane.ts";
import type { SignInLoginCredential, SignInVerifyLane } from "./sign-in-verify-lane.ts";
import type { TaskAuthPlumbing } from "./task-auth-plumbing.ts";

/** The store doors one completion needs; nothing here reads a secret back. */
export type SignInVerificationStore = Pick<
  ActorStore,
  | "getProject"
  | "createTeamSignIn"
  | "updateTeamSignIn"
  | "foldDuplicateTeamSignIn"
  | "bindProjectSignIn"
  | "claimProjectRunSignIn"
  | "chooseProjectRunSignIn"
  | "listProjectSignIns"
  | "readTeamSignInSecrets"
  | "recordTeamSignInEvent"
  | "resumeRunsWaitingForSignIn"
>;

export interface SignInVerificationContext {
  store: SignInVerificationStore;
  takeover: SignInTakeoverLane;
  verify: SignInVerifyLane;
  promote: TaskAuthPlumbing["promoteSignInAuthState"];
  /**
   * Keeps a leg being settled alive past the request that started it. A
   * resident service process outlives the request on its own; a hosted
   * Function stops at its answer unless told to wait.
   */
  background: (task: Promise<void>) => void;
  /** Wakes the dispatcher for the runs a way in turning ready put back on the queue. */
  onWorkAvailable: () => void | Promise<void>;
}

/** Checking a saved sign-in again needs no takeover browser. */
type SignInRecheckContext = Omit<SignInVerificationContext, "takeover">;

const FAILURE_REASONS: readonly TeamSignInFailureReason[] = [
  "wrong_credentials",
  "second_factor_required",
  "captcha_required",
  "login_page_not_found",
  "session_expired",
  "sso_enforced",
  "new_device_verification",
  "unknown",
];

/** A word the leg reported, kept only when the table knows it. */
function failureReason(reason: string | null): TeamSignInFailureReason {
  return FAILURE_REASONS.find((known) => known === reason) ?? "unknown";
}

/**
 * One leg, watched to its end.
 *
 * Whatever it says lands on the row and on the audit trail, and only a pass
 * that carries a session promotes anything. Both legs come through here, so a
 * password that keeps failing pauses on the third try exactly as a session
 * that keeps failing does.
 */
async function settle(
  context: SignInRecheckContext,
  input: {
    actor: TenantActor;
    teamId: string;
    projectId: string;
    productionUrl: string;
    /**
     * The page the leg opens with the session and must find itself inside: the
     * provider's own account page for a third-party way in, the product for
     * its own. Promotion always goes to the product.
     */
    checkUrl: string;
    signIn: TeamSignIn;
    /** A session a person made, for every method but the password one. */
    state?: Buffer | undefined;
    currentSession?: boolean;
    /** The credential the auto-login leg types, for the password one. */
    credential?: SignInLoginCredential | undefined;
    legActor: "verification_leg" | "auto_login_leg";
  },
): Promise<void> {
  const { store, verify, promote } = context;
  const { actor, teamId, projectId, signIn, legActor } = input;
  const outcome = await verify.verify({
    projectId,
    signInId: signIn.id,
    productionUrl: input.checkUrl,
    state: input.state,
    currentSession: input.currentSession === true,
    credential: input.credential,
  });
  // Getting inside is the whole test. Plenty of products never name the
  // account on the page they land on, and a session that works is not worth
  // less for it — the card falls back to the method, and the label stays
  // null rather than being invented.
  //
  // The session is the one the leg made, when it made one, and otherwise the
  // one it was handed. A pass carrying neither proved nothing this Project
  // can keep, so it counts as a failure rather than a tick.
  const sealedState = outcome.state ?? input.state ?? null;
  if (outcome.verified && sealedState) {
    // A leg that named an account the Team already saved under this method has
    // proved a way in the Team already holds. Two non-revoked rows may not
    // share (team, method, label), so ticking this row to that label would
    // collide with the unique index and leave it stranded `verifying`. The row
    // the Team already had is folded away first — its Projects move onto this
    // row, runs that signed in with it included, and it is revoked — and then
    // this row, whose session was just proved, ticks the way any other success
    // does. A null label names nobody and cannot collide, so it never folds.
    if (outcome.label) {
      await store.foldDuplicateTeamSignIn(actor, teamId, {
        method: signIn.method,
        label: outcome.label,
        newSignInId: signIn.id,
      });
    }
    // Runs start from the session of the way in they sign in with, so this
    // session replaces the Project's only when runs sign in with this way in:
    // the one they already use, or the first to be proved.
    if (await store.claimProjectRunSignIn(actor, teamId, projectId, signIn.id)) {
      await promote({
        teamId,
        projectId,
        productionUrl: input.productionUrl,
        sealedState,
      });
    }
    await store.updateTeamSignIn(actor, teamId, signIn.id, {
      status: "ready",
      label: outcome.label,
      failureReason: null,
      consecutiveFailures: 0,
      // Only the auto-login leg brings a session the row does not hold yet,
      // and a password way in names no GitHub account.
      ...(outcome.state && outcome.stateVersion
        ? { session: { state: outcome.state.toString("base64"), version: outcome.stateVersion, githubAccountLogin: null } }
        : {}),
    });
    await store.recordTeamSignInEvent(actor, teamId, {
      signInId: signIn.id,
      projectId,
      actor: legActor,
      action: legActor === "auto_login_leg" ? "auto_sign_in" : "verify_succeeded",
    });
    // Runs parked on a sign-in can sign in with this way in now, in every
    // Project whose runs use it: this one, or one a fold just moved onto it.
    await resumeRunsWaitingForSignIn(context, { actor, teamId, signInId: signIn.id });
    return;
  }
  const failure = signInFailureUpdate({
    consecutiveFailures: signIn.consecutiveFailures,
    reason: outcome.verified ? "unknown" : failureReason(outcome.reason),
  });
  await store.updateTeamSignIn(actor, teamId, signIn.id, failure);
  await store.recordTeamSignInEvent(actor, teamId, {
    signInId: signIn.id,
    projectId,
    actor: legActor,
    action: "verify_failed",
    outcome: failure.failureReason,
  });
  // The pause is its own line on the trail: "it failed again" and "it has
  // stopped trying" are different things to read a week later.
  if (failure.status !== "paused") return;
  await store.recordTeamSignInEvent(actor, teamId, {
    signInId: signIn.id,
    projectId,
    actor: legActor,
    action: "paused",
    outcome: failure.failureReason,
  });
}

/** What the leg is given: a credential to type, or a session to open the product with. */
type SignInLegMaterial =
  | { legActor: "auto_login_leg"; credential: SignInLoginCredential }
  | { legActor: "verification_leg"; state: Buffer };

/**
 * The material behind a saved sign-in, opened for one more check.
 *
 * The password lane types its credential in again; every other lane re-proves
 * the session a person captured, because that session is the only thing about
 * those methods this Project ever kept. A row holding neither has nothing to
 * check, and says so rather than spending a browser on it.
 */
async function legMaterial(
  store: SignInVerificationStore,
  input: { actor: TenantActor; teamId: string; signIn: TeamSignIn },
): Promise<SignInLegMaterial> {
  const { actor, teamId, signIn } = input;
  const secrets = await store.readTeamSignInSecrets(actor, teamId, signIn.id);
  if (signIn.method === "email_password") {
    const credential = secrets?.credential;
    if (!credential) {
      throw new HttpError(
        409,
        "SIGN_IN_CREDENTIAL_MISSING",
        "This sign-in has no saved password to try.",
      );
    }
    return {
      legActor: "auto_login_leg",
      credential: {
        email: credential.email,
        password: credential.password,
        totpSecret: credential.totpSecret,
        loginUrl: signIn.loginUrl,
      } satisfies SignInLoginCredential,
    };
  }
  const session = secrets?.session;
  if (!session) {
    throw new HttpError(
      409,
      "SIGN_IN_SESSION_MISSING",
      "This sign-in has no saved session to check; sign in once yourself to capture one.",
    );
  }
  // The row keeps base64 of the bytes the takeover sealed under the Project's
  // browser key, which is exactly what the leg is handed.
  return { legActor: "verification_leg", state: Buffer.from(session, "base64") };
}

/**
 * A sign-in this Project has bound and is not checking right now.
 *
 * Read through the Project's own bindings: a sign-in this Project never bound
 * is not one it may spend a browser on. And one row, one leg: a second leg
 * started while the first is still going takes the exchange directory out from
 * under it, and the leg that was already running ends `unknown` on a session
 * it never tried.
 */
async function boundSignIn(
  store: SignInVerificationStore,
  input: { actor: TenantActor; teamId: string; projectId: string; signInId: string },
): Promise<TeamSignIn> {
  const bound = (await store.listProjectSignIns(input.actor, input.teamId, input.projectId))
    .find((candidate) => candidate.id === input.signInId);
  if (!bound) throw new HttpError(404, "NOT_FOUND", "This Project has no such sign-in.");
  if (bound.status === "verifying") {
    throw new HttpError(
      409,
      "SIGN_IN_CHECK_IN_PROGRESS",
      "This sign-in is already being checked; wait for that check to finish.",
    );
  }
  return bound;
}

/**
 * The row a finished takeover saves to: the bound way in the person signed in
 * to again, or a new one. Signing in again keeps the row, and with it the
 * Projects on it and the GitHub authenticator saved for its account.
 */
export async function takeoverRow(
  store: SignInVerificationStore,
  input: Parameters<SignInVerificationGateway["complete"]>[0],
): Promise<TeamSignIn> {
  const { actor, teamId, projectId, method, signInId } = input;
  if (!signInId) return store.createTeamSignIn(actor, teamId, { method });
  const bound = await boundSignIn(store, { actor, teamId, projectId, signInId });
  if (bound.method !== method) {
    throw new HttpError(409, "SIGN_IN_METHOD_MISMATCH", "This sign-in is a different way in.");
  }
  return bound;
}

/**
 * "Check this one again", for a sign-in the Project already holds: the
 * auto-login leg for a saved password, the verification leg for a session
 * already kept. It needs no takeover browser, so a host without one can run it.
 */
export function createSignInRecheck(context: SignInRecheckContext): SignInVerificationGateway["verify"] {
  const { store } = context;
  return async ({ actor, teamId, projectId, signInId }) => {
    const productionUrl = (await store.getProject(actor, teamId, projectId))?.productionUrl;
    if (!productionUrl) {
      throw new HttpError(
        409,
        "PRODUCTION_URL_REQUIRED",
        "This Project has no Production URL, so there is nothing to sign in to.",
      );
    }
    const bound = await boundSignIn(store, { actor, teamId, projectId, signInId });
    const material = await legMaterial(store, { actor, teamId, signIn: bound });
    // A row that stopped trying starts again here, whichever lane it is on,
    // and the trail says so separately: "somebody asked for another check"
    // and "the pause is over" are different things to read back a week later.
    const resume = signInResumeUpdate(bound);
    const signIn = await store.updateTeamSignIn(actor, teamId, signInId, {
      ...resume,
      status: "verifying",
      failureReason: null,
    }) ?? bound;
    if (resume) {
      await store.recordTeamSignInEvent(actor, teamId, {
        signInId, projectId, actor: "user", action: "resumed",
      });
    }
    await store.recordTeamSignInEvent(actor, teamId, {
      signInId, projectId, actor: material.legActor, action: "verify_started",
    });
    context.background(settle(context, {
      actor, teamId, projectId, productionUrl, signIn, ...material,
      checkUrl: providerCheckUrl(bound.method) ?? productionUrl,
    }).catch((error: unknown) => {
      console.error("[sign-ins] the verification leg could not be settled:", error);
    }));
    return signIn;
  };
}

/**
 * The sign-in verification gateway: the two doors that start a leg, the
 * stream the page watches while one runs, and the owner's choice of the way in
 * runs sign in with.
 */
export function createSignInVerificationGateway(
  context: SignInVerificationContext,
): SignInVerificationGateway {
  const { store, takeover, verify } = context;

  return {
    streamUrl: (signInId) => verify.streamUrl(signInId),
    chooseForRuns: createRunSignInChoice(context),
    complete: async (input) => {
      const { actor, teamId, projectId, method } = input;
      const project = await store.getProject(actor, teamId, projectId);
      const productionUrl = project?.productionUrl;
      if (!productionUrl) {
        throw new HttpError(
          409,
          "PRODUCTION_URL_REQUIRED",
          "This Project has no Production URL, so there is nothing to check the sign-in against.",
        );
      }
      const captured = await takeover.capture(projectId);
      const target = await takeoverRow(store, input);
      // A session the person just made starts the row's count over.
      const signIn = await store.updateTeamSignIn(actor, teamId, target.id, {
        status: "verifying",
        failureReason: null,
        consecutiveFailures: 0,
        session: {
          state: captured.state.toString("base64"),
          version: captured.version,
          githubAccountLogin: captured.githubAccountLogin,
        },
      }) ?? target;
      await store.bindProjectSignIn(actor, teamId, projectId, signIn.id);
      for (const event of [
        { actor: "user" as const, action: "saved" as const },
        { actor: "verification_leg" as const, action: "verify_started" as const },
      ]) {
        await store.recordTeamSignInEvent(actor, teamId, { ...event, signInId: signIn.id, projectId });
      }
      context.background(settle(context, {
        actor, teamId, projectId, productionUrl, signIn,
        checkUrl: providerCheckUrl(method) ?? productionUrl,
        state: captured.state,
        currentSession: true,
        legActor: "verification_leg",
      }).catch((error: unknown) => {
        console.error("[sign-ins] the verification leg could not be settled:", error);
      }));
      return signIn;
    },

    verify: createSignInRecheck(context),
  };
}
