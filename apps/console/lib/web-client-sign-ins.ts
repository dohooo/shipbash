import {
  readGitHubAuthenticatorCodeContract,
  removeGitHubAuthenticatorContract,
  saveGitHubAuthenticatorContract,
} from "@shipbash/contracts/api/authenticators";
import {
  releaseSignInTakeoverContract,
  startSignInTakeoverContract,
} from "@shipbash/contracts/api/sign-in-takeover";
import {
  completeSignInTakeoverContract,
  verifySignInContract,
} from "@shipbash/contracts/api/sign-in-verification";
import {
  bindProjectSignInContract,
  chooseProjectRunSignInContract,
  createTeamSignInContract,
  deleteTeamSignInContract,
  unbindProjectSignInContract,
} from "@shipbash/contracts/api/sign-ins";
import type { TeamSignInMethod } from "@shipbash/contracts/database-contract-types";
import type { z } from "zod";

import { callApi } from "./api-client";

type CreateSignIn = z.input<typeof createTeamSignInContract.body>;
type SaveAuthenticator = z.input<typeof saveGitHubAuthenticatorContract.body>;

/**
 * The Project's sign-in browser. `startSignInTakeover` is the same call every
 * time: it opens the browser on the first ask and joins it afterwards,
 * answering the same stream and the same lease, so a page may re-ask to keep
 * the session alive without seizing anything. The method says where it
 * opens: a third-party one on the provider's own sign-in page, the rest on
 * the product.
 */
export const signInsClient = {
  readGitHubAuthenticatorCode: (projectId: string, signInId: string) =>
    callApi(readGitHubAuthenticatorCodeContract, { params: { projectId, signInId } }),
  saveGitHubAuthenticator: (projectId: string, signInId: string, body: SaveAuthenticator) =>
    callApi(saveGitHubAuthenticatorContract, { params: { projectId, signInId }, body }),
  removeGitHubAuthenticator: (projectId: string, signInId: string) =>
    callApi(removeGitHubAuthenticatorContract, { params: { projectId, signInId } }),
  startSignInTakeover: (projectId: string, method: TeamSignInMethod | null) =>
    callApi(startSignInTakeoverContract, { params: { projectId }, body: { method } }),
  releaseSignInTakeover: (projectId: string) =>
    callApi(releaseSignInTakeoverContract, { params: { projectId } }),
  createTeamSignIn: (teamId: string, body: CreateSignIn) =>
    callApi(createTeamSignInContract, { params: { teamId }, body }),
  removeTeamSignIn: (teamId: string, signInId: string) =>
    callApi(deleteTeamSignInContract, { params: { teamId, signInId } }),
  bindProjectSignIn: (projectId: string, signInId: string) =>
    callApi(bindProjectSignInContract, { params: { projectId }, body: { signInId } }),
  unbindProjectSignIn: (projectId: string, signInId: string) =>
    callApi(unbindProjectSignInContract, { params: { projectId, signInId } }),
  /**
   * "I'm done". It answers with a sign-in that is `verifying`, never one that
   * is ready: the tick comes from the leg this call starts, which the page
   * follows with readSignInVerification.
   */
  completeSignInTakeover: (
    projectId: string,
    method: Exclude<TeamSignInMethod, "email_password">,
  ) => callApi(completeSignInTakeoverContract, { params: { projectId }, body: { method } }),
  /**
   * Check a saved sign-in again, on the row it is already stored on. For the
   * password lane this is `Save and verify`: ShipBash types the credential
   * into the product's own login page. For every other method it re-opens the
   * product with the session already kept, which is how a way in that stopped
   * working accumulates failures instead of leaving a new row behind each
   * time. Like the takeover completion, it answers `verifying`.
   */
  verifySignIn: (projectId: string, signInId: string) =>
    callApi(verifySignInContract, { params: { projectId, signInId } }),
  /** Verification runs sign in with this ready way in from now on, starting from its session. */
  chooseRunSignIn: (projectId: string, signInId: string) =>
    callApi(chooseProjectRunSignInContract, { params: { projectId, signInId } }),
};
