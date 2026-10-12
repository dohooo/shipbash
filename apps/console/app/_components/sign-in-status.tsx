"use client";

import { TriangleAlert } from "lucide-react";

import type { TeamSignIn } from "../../lib/web-client";
import { METHOD_NAMES } from "./sign-in-methods";

/**
 * What a saved way in says about itself. Two surfaces read it — the Team's
 * credential page, which owns the credential, and the Project's settings card,
 * which only says which ways in this product uses — so the vocabulary is
 * stated once rather than worded twice and drifting.
 */

/**
 * A tick is the verification leg's to give, so everything short of `ready`
 * reads as not verified — and a row whose sealing key the deployment has lost
 * arrives already paused, which is why the pause is stated without a failure
 * count when there were none.
 */
export function signInState(signIn: TeamSignIn): { text: string; tone: string; stale: boolean } {
  if (signIn.status === "ready") return { text: "Verified", tone: " positive", stale: false };
  if (signIn.status === "paused") {
    const failures = signIn.consecutiveFailures;
    return {
      text: failures > 0 ? `Paused · ${String(failures)} failures` : "Paused",
      tone: "",
      stale: true,
    };
  }
  return { text: "Not verified", tone: "", stale: false };
}

/**
 * The hint the paused row earns: it is only true while something else still
 * works, and it has to name what that is — a sentence that says "Google" over
 * a team whose other way in is GitHub is a sentence that misinforms. A paused
 * way in that some product's runs sign in with makes it untrue: those runs
 * sign in with nothing else, so it is not said.
 *
 * It is a line of text, not a panel. A box drawn around one sentence competes
 * with the list it is annotating, and the colour already carries it.
 */
export function PausedHint({ signIns, runsUse }: {
  signIns: readonly TeamSignIn[];
  /** The ways in some product's verification runs sign in with. */
  runsUse: ReadonlySet<string>;
}) {
  const working = signIns.find((signIn) => signIn.status === "ready" && runsUse.has(signIn.id))
    ?? signIns.find((signIn) => signIn.status === "ready");
  const paused = signIns.filter((signIn) => signIn.status === "paused");
  if (!working || paused.length === 0 || paused.some((signIn) => runsUse.has(signIn.id))) return null;
  return (
    <p className="signin-hint">
      <TriangleAlert aria-hidden="true" />
      <span>
        Runs still work — ShipBash uses {METHOD_NAMES[working.method]}, and stops to ask only if
        that fails too.
      </span>
    </p>
  );
}
