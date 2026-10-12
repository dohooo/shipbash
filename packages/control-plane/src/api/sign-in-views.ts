/**
 * Read-model shaping for Team sign-ins, kept apart from `views.ts` because
 * this is the one projection with a rule of its own: the wire carries what a
 * sign-in *is* and never what it *keeps*. There is no ciphertext field, no
 * credential field and no session field to forget to strip — the view is built
 * from named columns, so a secret can only ever reach a client if someone adds
 * it here on purpose.
 */
import type { BoundSignInView, TeamSignInView, ProjectSignInBindingView } from "@shipbash/contracts/api/view-types";

import type { BoundSignIn, ProjectSignInBinding } from "../store/team-sign-in-bindings.ts";
import type { TeamSignIn } from "../store/team-sign-ins.ts";

export function teamSignInView(signIn: TeamSignIn): TeamSignInView {
  return {
    id: signIn.id,
    teamId: signIn.teamId,
    method: signIn.method,
    label: signIn.label,
    loginUrl: signIn.loginUrl,
    status: signIn.status,
    failureReason: signIn.failureReason,
    consecutiveFailures: signIn.consecutiveFailures,
    keyAvailable: signIn.encryptionKeyAvailable,
    lastVerifiedAt: signIn.lastVerifiedAt,
    createdAt: signIn.createdAt,
    updatedAt: signIn.updatedAt,
  };
}

export function boundSignInView(signIn: BoundSignIn): BoundSignInView {
  return { ...teamSignInView(signIn), forRuns: signIn.forRuns };
}

export function projectSignInBindingView(binding: ProjectSignInBinding): ProjectSignInBindingView {
  return {
    projectId: binding.projectId,
    signInId: binding.signInId,
    teamId: binding.teamId,
    createdAt: binding.createdAt,
  };
}
