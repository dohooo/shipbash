// The first-frame sign-in wall verdict, from
// Jev's judgment of the page (page-kind.mjs) and what the harness knows about
// the run. Pure: no I/O, no browser; the plumbing lives in first-frame.mjs.
//
// A wall is a page only the owner can get past — a sign-in screen, a screen
// that only leads to one (session ended, private link), a second factor, an
// account choice. The harness confirms one only when Jev answered that kind
// at or above the calibrated bar AND no saved sign-in was applied (a wall
// with no credentials behind it is deterministic). Two cases it must get right:
// a valid session that flashes the sign-in screen before it redirects (so the
// caller waits for the redirect first), and a valid session behind a sign-in
// form that never redirects (so a wall behind a saved sign-in is never
// confirmed here; the agent probes the entry point). A page Jev did
// not judge is never a wall, and never silently "no wall" either: it gets its
// own tier, and the agent reads the frame itself.
import { confirmedWall, needsOwner } from "../page-kind.mjs";

const SIGN_IN_STATES = Object.freeze(["none", "saved_state", "handoff_candidate"]);

const KIND_WORDS = {
  sign_in: "a sign-in screen with nothing else to use",
  sign_in_prompt: "a screen saying you must sign in, whose only control leads to the sign-in form",
  second_factor: "a later step of signing in that asks for a code",
  account_choice: "a later step of signing in that asks which account to continue with",
};

/** What the page is, in the words the agent reads. */
export function kindWords(kind) {
  return KIND_WORDS[kind] ?? "a sign-in surface";
}

/** An unrecognised sign-in state reads as a saved one: never confirm on a guess. */
function normalizeSignInState(value) {
  if (value === undefined || value === null) return "none";
  return SIGN_IN_STATES.includes(value) ? value : "saved_state";
}

/**
 * What the harness knows about the run that forbids filing on the page by
 * itself: the saved sign-in did not load (a harness fault, not the product's
 * wall); a takeover just completed and the page still needs the owner (the
 * captured state did not take, and filing again would loop the takeover); the
 * owner spoke as the round opened (their words outrank a verdict).
 */
function runExclusions(signInState, run, owner) {
  const exclusions = [];
  if (signInState !== "none" && run.restoreLoaded === false) exclusions.push("sign_in_state_not_loaded");
  if (signInState === "handoff_candidate" && owner) exclusions.push("handoff_did_not_take");
  if (run.ownerMessagePending === true) exclusions.push("owner_message_pending");
  return exclusions;
}

/**
 * The verdict for one first frame.
 *
 * Tiers: `confirmed` — Jev is sure the page needs the owner, nothing
 * excludes it, and no saved sign-in was applied, so the harness stands behind
 * it; `wall_with_state` — the same behind a saved sign-in that still stands
 * after the settle; `excluded` — the page needs the owner, but
 * something the harness knows says it must not be filed on automatically;
 * `suspected` — Jev's top answer needs the owner, below the bar;
 * `unjudged` — Jev gave no answer (no key, a timeout, an HTTP error such as
 * 402 for exhausted credits, a malformed answer), so nothing was decided;
 * `none` — anything else.
 *
 * @param {import("../page-kind.mjs").PageJudgment} judgment
 * @param {{ signInState?: string, restoreLoaded?: boolean | null, ownerMessagePending?: boolean }} run
 */
export function firstFrameVerdict(judgment, run) {
  const signInState = normalizeSignInState(run.signInState);
  const owner = needsOwner(judgment);
  const exclusions = runExclusions(signInState, run, owner);
  let tier = judgment.kind === null ? "unjudged" : "none";
  if (owner && exclusions.length > 0) tier = "excluded";
  else if (owner && !confirmedWall(judgment)) tier = "suspected";
  else if (owner) tier = signInState === "none" ? "confirmed" : "wall_with_state";
  return { tier, kind: judgment.kind, confidence: judgment.confidence, error: judgment.error ?? null, exclusions, signInState };
}
