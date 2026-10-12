/**
 * When a saved sign-in stops trying, and what lets it start again.
 *
 * One failed check is a bad moment. Three in a row is a way in that no longer
 * works, and going on retrying it buys nothing — every run stops at the same
 * wall with the same word. So the third consecutive failure pauses the row
 * instead of failing it again, which is also the count `team_sign_ins_paused_check`
 * insists on, and the pause holds until a person replaces what is behind it.
 *
 * The one pause this module refuses to lift is the pause the deployment caused.
 * A row whose sealing key has gone from the environment reads as paused without
 * ever having failed, and writing a status over it would spend a tick the row
 * still holds. That one ends when the key comes back — or when a replacement
 * credential is sealed with the key in hand, which makes the row readable again
 * on its own.
 */
import type {
  TeamSignInFailureReason,
  TeamSignInStatus,
} from "@shipbash/contracts/database-contract-types";

/** Three checks in a row, the product's answer and the table's. */
export const SIGN_IN_PAUSE_AFTER_FAILURES = 3;

export interface SignInFailureUpdate {
  status: Extract<TeamSignInStatus, "failed" | "paused">;
  failureReason: TeamSignInFailureReason;
  consecutiveFailures: number;
}

/** What one more failure does to the row, counting the one just reported. */
export function signInFailureUpdate(input: {
  consecutiveFailures: number;
  reason: TeamSignInFailureReason;
}): SignInFailureUpdate {
  const consecutiveFailures = input.consecutiveFailures + 1;
  return {
    status: consecutiveFailures >= SIGN_IN_PAUSE_AFTER_FAILURES ? "paused" : "failed",
    failureReason: input.reason,
    consecutiveFailures,
  };
}

export interface SignInResumeUpdate {
  status: Extract<TeamSignInStatus, "unverified">;
  failureReason: null;
  consecutiveFailures: 0;
}

/**
 * The pause this row is under, lifted — or null when there is none to lift, so
 * a caller that merges this in leaves every other row's status exactly as it
 * found it.
 *
 * Lifting a pause returns the row to unverified, never to `verifying`. That
 * word means a leg is open on this sign-in right now, and only the call that
 * starts one may say it; a row parked in `verifying` with nothing behind it
 * would spin on the page forever.
 */
export function signInResumeUpdate(signIn: {
  status: TeamSignInStatus;
  encryptionKeyAvailable: boolean;
}): SignInResumeUpdate | null {
  if (signIn.status !== "paused" || !signIn.encryptionKeyAvailable) return null;
  return { status: "unverified", failureReason: null, consecutiveFailures: 0 };
}
