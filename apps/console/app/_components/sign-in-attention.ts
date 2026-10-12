"use client";

/**
 * A paused way into the product, as something that needs the owner.
 *
 * This is the only notice a pause gets — no mail, no message — so the row has
 * to carry what a person needs to decide without opening anything: which way
 * in stopped, which account it was, and what the checks actually reported. The
 * reason is worded exactly as the sign-in card words it, because a reader who
 * saw one of them yesterday should not have to translate the other.
 *
 * A pause with no failures behind it is a deployment that lost the key that
 * sealed the row, not a sign-in that stopped working. It still stops the next
 * run, so it is still stated — but a count of zero is never claimed as one.
 */
import type { Route } from "next";

import type { TeamSignIn } from "../../lib/web-client";
import type { AttentionItem } from "../_lib/journeys";
import { signInFailure } from "./sign-in-card";
import { METHOD_NAMES } from "./sign-in-methods";

function pausedTitle(signIn: TeamSignIn): string {
  const method = METHOD_NAMES[signIn.method];
  const failures = signIn.consecutiveFailures;
  return failures > 0
    ? `Sign-in paused · ${method} · ${String(failures)} failures`
    : `Sign-in paused · ${method}`;
}

/** The account it was, and why it stopped, in one sentence. */
function pausedBody(signIn: TeamSignIn): string {
  const reason = signInFailure(signIn.failureReason, signIn.method).text;
  return signIn.label ? `${signIn.label} — ${reason}` : reason;
}

export function signInAttentionItems(
  signIns: readonly TeamSignIn[],
  teamHref: (pathname: string) => Route,
): AttentionItem[] {
  return signIns
    .filter((signIn) => signIn.status === "paused")
    .map((signIn) => ({
      id: `sign-in-${signIn.id}`,
      title: pausedTitle(signIn),
      body: pausedBody(signIn),
      actionLabel: "Fix in team",
      href: teamHref("/settings/sign-ins"),
    }));
}
