import type { SuiteRunDetail } from "@shipbash/contracts/execution-types";
import { isJourneyRole } from "@shipbash/contracts/runtime/case-role-contract.mjs";
import { SIGN_IN_WINDOW_EXPIRED_REASON } from "./sign-in-window.ts";
import type { CaseVerdict } from "./types.ts";

/** A run on a schedule and a run someone asked for read differently in a channel. */
export type SlackAlertTrigger = "scheduled" | "manual";

/**
 * Why a run verified nothing. The three causes are kept apart because each
 * sends the reader somewhere else: a sign-in to renew, an environment to
 * unblock, or a fault that is ours.
 */
export type SlackAlertBlocker =
  | "sign_in_required"
  | "blocked"
  | "infrastructure_error";

/**
 * What each Journey of a run is called across runs, by the snapshot Case the
 * run walked: its Suite Case where it has one, and otherwise the snapshot Case
 * it only ever existed as. Read beside the run rather than carried on it,
 * because only the alert needs it — the report renders one run.
 */
export type JourneySubjects = ReadonlyMap<string, string>;

/**
 * One open row of `run_auth_attention`, narrowed to what the alert says out
 * loud. `AuthAttentionStore.list(actor, teamId, projectId, runId)` returns
 * these — and only the open ones, which is what a finished run should report.
 */
export interface RunAuthAttention {
  accountLogin: string | null;
}

/**
 * The run's sign-in trouble, which the run read model does not carry. The
 * caller passes both records, because either one alone misses a real case:
 * the credential broker writes attention rows and the expired-waiting sweep
 * does not, while the sweep is the only thing that stamps the run's reason.
 */
export interface RunAuthFacts {
  attention: readonly RunAuthAttention[];
  /** `suite_runs.failure_reason` for this run. */
  runFailureReason: string | null;
}

export interface SlackAlertJourney {
  /**
   * What this journey is called across runs: its Suite Case where it has one,
   * and otherwise the snapshot Case it only ever existed as. A thread is held
   * open against this, so it has to survive a re-run and an edit — the Case
   * Run id would open a fresh thread every night.
   */
  subject: string;
  /**
   * This run's walk of the journey: what a reply's "View details" opens and
   * whose replay a failure reply carries. Null only if the walk never started.
   */
  caseRunId: string | null;
  title: string;
  verdict: CaseVerdict | null;
  /** The goal of the first checkpoint that broke. */
  stoppedAtGoal: string | null;
  /** That checkpoint's id, which a later run compares against to say whether it moved. */
  stoppedAtCheckpoint: string | null;
  /** What was seen instead. Already sanitized where the run was written. */
  reason: string | null;
}

/** Everything the run's Slack messages read about a finished run, and no more. */
export interface SlackAlertView {
  runId: string;
  projectName: string;
  suiteName: string;
  trigger: SlackAlertTrigger;
  /** When the run started, ISO-8601. Slack shows it in each reader's own time zone. */
  triggeredAt: string;
  journeys: SlackAlertJourney[];
  blocker: SlackAlertBlocker | null;
  /** The account a sign-in is owed for, when an attention row names one. */
  signInAccount: string | null;
  /** The observed cause behind the blocker, when a walk recorded one. */
  blockerDetail: string | null;
  /** Journeys this run set out to verify and returned no verdict about. */
  skippedJourneys: number;
}

/**
 * What a finished run has to say, and what the caller needs to say it.
 * Recovery is the caller's to know: only it remembers what was red.
 */
export type SlackAlertDecision =
  | { kind: "failed" }
  | { kind: "could_not_verify"; blocker: SlackAlertBlocker };

type CaseEntry = SuiteRunDetail["cases"][number];

/** A journey the run walked towards and came back from with no verdict. */
function isUnverified(verdict: CaseVerdict | null): boolean {
  return (
    verdict === null ||
    verdict === "not_run" ||
    verdict === "blocked" ||
    verdict === "error"
  );
}

function journeyOf(entry: CaseEntry, subjects: JourneySubjects): SlackAlertJourney {
  const caseRun = entry.caseRun;
  // The checkpoint the walk stopped at is the first one that broke; the ones
  // after it were never reached, so a later failure is not where it stopped.
  const broke = caseRun?.checklist.find((item) => item.status === "failed");
  return {
    subject: subjects.get(entry.snapshotCaseId) ?? entry.snapshotCaseId,
    caseRunId: caseRun?.id ?? null,
    title: entry.title,
    verdict: caseRun?.verdict ?? null,
    stoppedAtGoal: broke?.goal ?? null,
    stoppedAtCheckpoint: broke?.id ?? null,
    reason: caseRun?.failureReason ?? null,
  };
}

/**
 * A run that needed a human to sign in. By the time an alert is sent the run
 * has finished, so its status is never `waiting_for_auth` any more: the
 * expired-waiting sweep has closed it as completed and blocked. That leaves
 * two canonical records, and a finished run needs either to qualify — an open
 * attention row the credential broker wrote, or the sweep's own reason on the
 * run, matched against the constant it was written from.
 */
function needsSignIn(auth: RunAuthFacts): boolean {
  if (auth.attention.length > 0) return true;
  return auth.runFailureReason === SIGN_IN_WINDOW_EXPIRED_REASON;
}

/**
 * The cause worth announcing, or null when there is none. A run someone
 * canceled reports nothing: it proved nothing, but a human already knows why,
 * and its unwalked journeys would otherwise read as an environment failure.
 */
function runBlocker(
  run: SuiteRunDetail["run"],
  journeys: readonly SlackAlertJourney[],
  auth: RunAuthFacts,
): SlackAlertBlocker | null {
  if (run.status === "canceled" || run.status === "canceling") return null;
  if (run.verdict === "canceled") return null;
  if (needsSignIn(auth)) return "sign_in_required";
  if (run.verdict === "error" || journeys.some((journey) => journey.verdict === "error")) {
    return "infrastructure_error";
  }
  if (run.verdict === "blocked" || journeys.some((journey) => journey.verdict === "blocked")) {
    return "blocked";
  }
  return null;
}

/**
 * The alert's view of a finished run. Only Journeys are counted: the setup and
 * teardown hooks around them carry their own verdicts, never the run's.
 */
export function runAlertView(
  detail: SuiteRunDetail,
  auth: RunAuthFacts,
  subjects: JourneySubjects,
): SlackAlertView {
  const journeys = detail.cases
    .filter((entry) => isJourneyRole(entry.role))
    .map((entry) => journeyOf(entry, subjects));
  return {
    runId: detail.run.id,
    projectName: detail.projectName,
    suiteName: detail.suiteName ?? "Verification",
    trigger: detail.run.triggerKind === "scheduled" ? "scheduled" : "manual",
    triggeredAt: detail.run.startedAt ?? detail.run.createdAt,
    journeys,
    blocker: runBlocker(detail.run, journeys, auth),
    signInAccount: auth.attention.find((row) => row.accountLogin !== null)?.accountLogin ?? null,
    blockerDetail:
      journeys.find((journey) => isUnverified(journey.verdict) && journey.reason !== null)
        ?.reason ?? null,
    skippedJourneys: journeys.filter((journey) => isUnverified(journey.verdict)).length,
  };
}

/**
 * What to say about a finished run, or nothing. A journey that failed is a
 * product failure and outranks everything: the run may also have been cut
 * short, but an observed break is still worth the channel's attention.
 */
export function classifyRunAlert(view: SlackAlertView): SlackAlertDecision | null {
  if (view.journeys.some((journey) => journey.verdict === "failed")) return { kind: "failed" };
  return view.blocker === null ? null : { kind: "could_not_verify", blocker: view.blocker };
}
