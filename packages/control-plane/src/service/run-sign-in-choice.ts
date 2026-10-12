/**
 * "Runs sign in with this one": the owner moves a Project's verification runs
 * onto another of its ready ways in. The first way in a Project proves becomes
 * the runs' on its own (`settle`); this is the switch to a later one. The
 * session the chosen way in keeps becomes the one runs start from, as a proved
 * way in's does when runs already use it.
 *
 * Whichever way the runs' way in turns ready, the runs parked on a sign-in
 * resume on their own (resumeRunsWaitingForSignIn).
 */
import type { SignInVerificationGateway } from "../api/gateways.ts";
import type { TenantActor } from "../types.ts";
import { HttpError } from "./http-input.ts";
import type { SignInVerificationContext, SignInVerificationStore } from "./sign-in-verification.ts";

/**
 * The runs parked on a sign-in go back on the queue once the way in they sign
 * in with is ready, in every Project of the Team whose runs use it, through
 * the resume "I'm done" uses, and the dispatcher is woken for them. The store
 * resumes nothing for a way in that is not ready or not a Project's runs',
 * and never the same run twice.
 */
export async function resumeRunsWaitingForSignIn(
  context: {
    store: Pick<SignInVerificationStore, "resumeRunsWaitingForSignIn">;
    onWorkAvailable: SignInVerificationContext["onWorkAvailable"];
  },
  input: { actor: TenantActor; teamId: string; signInId: string },
): Promise<void> {
  const resumed = await context.store.resumeRunsWaitingForSignIn(input.actor, input.teamId, input.signInId);
  if (resumed.length > 0) await context.onWorkAvailable();
}

export function createRunSignInChoice(context: {
  store: Pick<SignInVerificationStore, "getProject" | "chooseProjectRunSignIn" | "readTeamSignInSecrets" | "resumeRunsWaitingForSignIn">;
  /** Where a way in's session becomes the one the Project's runs start from, on this lane. */
  promote: SignInVerificationContext["promote"];
  onWorkAvailable: SignInVerificationContext["onWorkAvailable"];
}): SignInVerificationGateway["chooseForRuns"] {
  const { store, promote } = context;
  return async ({ actor, teamId, projectId, signInId }) => {
    const productionUrl = (await store.getProject(actor, teamId, projectId))?.productionUrl;
    if (!productionUrl) {
      throw new HttpError(409, "PRODUCTION_URL_REQUIRED", "This Project has no Production URL, so its runs have nothing to sign in to.");
    }
    if (!await store.chooseProjectRunSignIn(actor, teamId, projectId, signInId)) {
      throw new HttpError(409, "SIGN_IN_NOT_READY", "Runs can only sign in with a ready way in this Project uses.");
    }
    // A ready way in keeps the session it was proved with (team_sign_ins_ready_check).
    const session = (await store.readTeamSignInSecrets(actor, teamId, signInId))?.session;
    if (session) await promote({ teamId, projectId, productionUrl, sealedState: Buffer.from(session, "base64") });
    await resumeRunsWaitingForSignIn(context, { actor, teamId, signInId });
  };
}
