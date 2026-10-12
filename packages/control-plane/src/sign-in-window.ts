/**
 * The reason the expired-waiting sweep stamps on a run whose sign-in window
 * lapsed, in the owner's words.
 *
 * It lives on its own because two layers now read it and they must not depend
 * on each other: `store/dispatch-waiting-expiry.ts` writes it when it closes
 * the run, and the Slack alert recognises it as "this run needed a human
 * sign-in". The alert is a pure module and cannot import a store module to
 * find out, and neither side may copy the string — a second copy would drift
 * and the alert would quietly stop recognising the case.
 */
export const SIGN_IN_WINDOW_EXPIRED_REASON =
  "The sign-in window expired before the sign-in was completed. Start a new run and finish the sign-in to continue.";
