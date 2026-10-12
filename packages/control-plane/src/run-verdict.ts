/**
 * The Run verdict rule, in one place.
 *
 * Dispatch settlement counts a run's Case Runs in SQL and writes the answer
 * into `suite_runs.verdict`; a run page reads its family — the run and the
 * retries hung off it — and recomputes the same answer over the latest
 * attempt of each Case. Two copies of this rule would let the stored verdict
 * and the page disagree about the same walk.
 */
import type {
  CaseRunStatus,
  CaseVerdict,
  RunVerdict,
  SuiteCaseRole,
} from "@shipbash/contracts/database-contract-types";

/** What the run's Case Runs add up to; a Journey nobody walked counts as not_run. */
export interface RunVerdictTally {
  errors: number;
  hookFailures: number;
  failed: number;
  blocked: number;
  not_run: number;
  canceled: number;
}

/** The run verdict from its Journeys' rows: a journey nobody walked cannot make a run "passed". */
export function runVerdict(tally: RunVerdictTally): RunVerdict {
  if (tally.errors > 0) return "error";
  if (tally.hookFailures > 0) return "blocked";
  if (tally.failed > 0) return "failed";
  if (tally.blocked > 0 || tally.not_run > 0) return "blocked";
  return tally.canceled > 0 ? "canceled" : "passed";
}

/** One Case of the run at its latest attempt; a status of null means never walked. */
export interface LatestCaseAttempt {
  role: SuiteCaseRole;
  status: CaseRunStatus | null;
  verdict: CaseVerdict | null;
}

const TERMINAL_CASE_STATUSES = new Set<CaseRunStatus>(["completed", "canceled"]);
const HOOK_FAILURE_VERDICTS = new Set<CaseVerdict>(["failed", "blocked", "error"]);

function latestVerdict(entry: LatestCaseAttempt): CaseVerdict {
  return entry.status === null ? "not_run" : entry.verdict ?? "not_run";
}

/**
 * The verdict a run page shows, over the latest attempt of each Case — null
 * while any of them is still walking, because a run in flight has no
 * conclusion to show.
 */
export function runVerdictOfLatestAttempts(
  cases: readonly LatestCaseAttempt[],
): RunVerdict | null {
  const journeys = cases.filter((entry) => entry.role === "journey");
  if (journeys.length === 0) return null;
  if (cases.some((entry) => entry.status !== null && !TERMINAL_CASE_STATUSES.has(entry.status))) {
    return null;
  }
  const journeysWith = (verdict: CaseVerdict) =>
    journeys.filter((entry) => latestVerdict(entry) === verdict).length;
  return runVerdict({
    errors: journeysWith("error"),
    failed: journeysWith("failed"),
    blocked: journeysWith("blocked"),
    not_run: journeysWith("not_run"),
    canceled: journeysWith("canceled"),
    // A hook's verdict is its own, never the run's — but a run whose setup
    // or teardown broke did not verify what it claims to have verified.
    hookFailures: cases.filter((entry) =>
      entry.role !== "journey" && entry.verdict !== null && HOOK_FAILURE_VERDICTS.has(entry.verdict),
    ).length,
  });
}
