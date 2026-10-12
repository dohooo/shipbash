/**
 * The suite runner's pure Case verdict shapes: the harness-fault, takeover,
 * challenge, and reproduction results a walk can end in without the agent
 * finishing. Everything here is a plain function from facts to a result
 * object — no process state, no emit — so the wording a reader sees when
 * ShipBash itself is at fault lives in exactly one reviewable place.
 */
import { validateChecklistItems } from "@shipbash/contracts/runtime/checklist-contract.mjs";

import { validateCaseResult } from "./suite-runner/case-results.mjs";

/**
 * A failure is not an alert until it happens twice. The immediate re-run is
 * the reproduction attempt; this folds its outcome back into one verdict:
 * reproduced failures stay failures, a passing re-run exempts the case as
 * flaky, and a re-run that could not finish downgrades to the non-alerting
 * channel it landed in — an unconfirmed failure must never page anyone.
 * The checklist is the re-run's: a checkpoint the first walk failed and the
 * re-run passed stays passed, and the summary says it failed once.
 */
export function reconcileReproduction(original, reproduction) {
  const result = reproductionVerdict(original, reproduction);
  const cleared = clearedOnReRun(original.checklist ?? [], reproduction.checklist ?? []);
  return cleared.length > 0 ? { ...result, summary: [result.summary, ...cleared].join("\n") } : result;
}

/** One line per checkpoint the first walk failed and the re-run passed. */
function clearedOnReRun(originalChecklist, reproductionChecklist) {
  const failedFirst = new Map(
    originalChecklist.filter((item) => item.status === "failed").map((item) => [item.id, item.reason]),
  );
  return reproductionChecklist
    .filter((item) => item.status === "passed" && failedFirst.has(item.id))
    .map((item) => {
      const reason = failedFirst.get(item.id)?.replace(/\.$/u, "");
      return `${item.id} failed on the first walk${reason ? ` (${reason})` : ""} and passed on the re-run.`;
    });
}

function reproductionVerdict(original, reproduction) {
  if (reproduction.outcome === "failed") {
    return {
      ...reproduction,
      summary: reproduction.summary,
      failureReason: reproduction.failureReason ?? original.failureReason,
    };
  }
  if (reproduction.outcome === "passed") {
    return {
      ...reproduction,
      outcome: "exempted",
      summary: "The first walk failed but an immediate re-run passed, so it counts as flaky, not as a failure. No alert raised.",
      failureReason: original.failureReason,
    };
  }
  if (reproduction.outcome === "auth_required") {
    const summary = "Authentication interfered before the failure could be reproduced, so no alert was raised.";
    return {
      ...reproduction,
      outcome: "blocked",
      summary,
      failureReason: original.failureReason ?? summary,
    };
  }
  // blocked / error keep their own non-alerting channel.
  return reproduction;
}

export function assessAuthValidationResult(result) {
  if (result.outcome === "error") {
    return "error";
  }
  if (result.outcome === "blocked") {
    return "blocked";
  }
  if (result.authState === "unauthenticated") {
    return "handoff";
  }
  if (
    result.authState === "authenticated" &&
    (result.outcome === "passed" || result.outcome === "failed")
  ) {
    return "promote";
  }
  return "blocked";
}

export function terminalizeInterruptedChecklist(checklist, reason) {
  if (!Array.isArray(checklist) || checklist.length === 0) return [];
  return validateChecklistItems(checklist).map((item) => {
    if (item.status === "pending") return { ...item, status: "not_run", reason: null };
    if (item.status === "in_progress") return { ...item, status: "blocked", reason };
    return item;
  });
}

export function authTakeoverBlockedResult(timeoutMs, checklist = []) {
  const reason = `Authentication takeover timed out after ${timeoutMs} ms.`;
  return {
    outcome: "blocked",
    authState: "unauthenticated",
    summary: "The test is blocked because human authentication was not completed in time.",
    failureReason: reason,
    keyActions: [],
    checklist: terminalizeInterruptedChecklist(checklist, reason),
  };
}

export function authTakeoverCanceledResult(checklist = []) {
  const reason = "Authentication takeover was canceled by the user.";
  return {
    outcome: "blocked",
    authState: "unauthenticated",
    summary: "The test is blocked because human authentication takeover was canceled.",
    failureReason: reason,
    keyActions: [],
    checklist: terminalizeInterruptedChecklist(checklist, reason),
  };
}

export function cloudflareChallengeBlockedResult(checklist = [], checkpoints = []) {
  const reason = "Cloudflare security verification blocked access to the Production product.";
  return stoppedCaseResult("blocked", reason,
    `${reason} Configure trusted Production access for this Project, then retry.`, checklist, checkpoints);
}

/**
 * A walk stopped by something other than its product — a wall in front of
 * it, its browser — said in words instead of leaking the ENOENT of the result
 * file the stopped agent never got to write.
 */
function stoppedCaseResult(outcome, reason, failureReason, checklist, checkpoints) {
  const baseline = checklist.length > 0
    ? checklist
    : checkpoints.slice(0, 5).map((goal, index) => ({
        id: `checkpoint-${index + 1}`,
        goal: String(goal).trim().slice(0, 300),
        status: index === 0 ? "in_progress" : "pending",
        reason: null,
      }));
  return {
    outcome,
    authState: "unknown",
    summary: reason,
    failureReason,
    keyActions: [],
    checklist: terminalizeInterruptedChecklist(baseline, reason),
  };
}

const TIMED_OUT = "The case agent execution timed out.";
const UNFINISHED = "The walk ended before this checkpoint was judged.";

/** Jev's own document of the walk as any delivered result is read (case-results.mjs), or null when it is not one. */
function observedResult(observed) {
  try {
    return validateCaseResult(observed);
  } catch {
    return null;
  }
}

/**
 * A Journey whose supervising turn ended undelivered, and not canceled, after
 * Jev read a checkpoint as contradicted (jev-verification.mjs). While that
 * checkpoint is still in_progress, Jev's observed failure is the verdict, so a
 * real failure still alerts and is reproduced. Once the supervising agent
 * reported it blocked or failed, its latest reported checklist is the
 * verdict: failed when any of it failed, blocked otherwise. Reported passed
 * (or not run), Jev was overruled, and so is a document that does not
 * validate: null, and the walk is judged as any stopped walk is.
 * @param {unknown} observed Jev's own document of the walk
 * @param {unknown} checklist the checklist reported last
 */
export function unfinishedSupervisionResult(observed, checklist) {
  const jev = observedResult(observed);
  if (!jev) return null;
  const reported = Array.isArray(checklist) && checklist.length > 0 ? validateChecklistItems(checklist) : [];
  const contradicted = jev.checklist.find((item) => item.status === "failed");
  const ruled = reported.find((item) => item.id === contradicted?.id);
  if (!ruled || ruled.status === "in_progress") return jev;
  if (ruled.status !== "blocked" && ruled.status !== "failed") return null;
  const verdict = reported.find((item) => item.status === "failed") ?? ruled;
  const reason = verdict.reason ?? `${verdict.id} was reported ${verdict.status}.`;
  return {
    outcome: verdict.status,
    authState: "unknown",
    summary: `${verdict.status === "failed" ? "Failed" : "Blocked"} — ${reason} The walk ended before its closing report.`,
    failureReason: reason,
    keyActions: [],
    checklist: terminalizeInterruptedChecklist(reported, UNFINISHED),
  };
}

/**
 * A walk whose time ran out. When it had already reported every checkpoint
 * passed, it proved what it set out to and only its closing report is
 * missing: the checklist it reported is the verdict. Short of that, the
 * timeout is the verdict, with what the walk had reported kept beside it.
 * @param {unknown} checklist the checklist the walk reported before its time ran out
 */
export function timedOutCaseResult(checklist) {
  const reported = Array.isArray(checklist) && checklist.length > 0 ? validateChecklistItems(checklist) : [];
  if (reported.length > 0 && reported.every((item) => item.status === "passed")) {
    return {
      outcome: "passed",
      authState: "unknown",
      summary: "Passed — every checkpoint was reported passed before the walk ran out of time, so its closing summary is missing.",
      failureReason: null,
      keyActions: [],
      checklist: reported,
    };
  }
  return {
    outcome: "error",
    authState: "unknown",
    summary: "The case agent exceeded its execution timeout.",
    failureReason: TIMED_OUT,
    keyActions: [],
    checklist: terminalizeInterruptedChecklist(reported, TIMED_OUT),
  };
}

/**
 * The browser this walk was driving is gone (attaching to it again was
 * refused), and any browser after it would have none of its sign-in or page
 * state: this attempt could verify nothing more. Blocked, never failed.
 */
export function browserGoneCaseResult(checklist = [], checkpoints = []) {
  const reason = "The browser this journey was walking is gone, and with it the sign-in and page state the walk had.";
  return stoppedCaseResult("blocked", reason,
    `${reason} ShipBash stopped the walk rather than judge your product from a browser it did not open.`, checklist, checkpoints);
}

/**
 * ShipBash's browser stopped answering and a step failed on it: a fault on
 * ShipBash's side, an error like a browser that never started, so the run
 * stops here instead of the next Journey opening on the same silent browser.
 * @param {number} silentMs how long the browser had not answered when the walk stopped
 */
export function browserUnresponsiveCaseResult(silentMs, checklist = [], checkpoints = []) {
  const reason = `ShipBash's browser for this journey stopped answering: it had not answered for at least ${String(Math.floor(silentMs / 1_000))} s.`;
  return stoppedCaseResult("error", reason,
    `${reason} This is a ShipBash-side fault, not a finding about your product.`, checklist, checkpoints);
}

/**
 * A case that never got a working browser failed on ShipBash's side, and the
 * reader should be told that in those terms. The command that broke is real
 * evidence, but it belongs in the event's diagnostics, not in the sentence a
 * product owner reads about their own product.
 */
export function infrastructureFailureReason(error) {
  const timedOut = error?.diagnostics?.timedOut === true;
  return timedOut
    ? "ShipBash could not get a browser ready for this journey in time, so the walk never started. This is a ShipBash-side fault, not a finding about your product."
    : "ShipBash could not get a browser ready for this journey, so the walk never started. This is a ShipBash-side fault, not a finding about your product.";
}

export function unverifiedAuthCandidateResult(validationResult) {
  return {
    outcome: "blocked",
    authState: validationResult.authState,
    summary: "The test is blocked because the fresh browser could not verify the authentication candidate.",
    failureReason:
      validationResult.outcome === "blocked" && validationResult.failureReason
        ? validationResult.failureReason
        : "Authentication state was not proven as authenticated by a passed or failed fresh-case run.",
    keyActions: validationResult.keyActions,
    checklist: validationResult.checklist,
  };
}
