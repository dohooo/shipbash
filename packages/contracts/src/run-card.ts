/**
 * A run's card, decided once for both addresses that draw it: a shared run's
 * page, and a private run's page read by someone not signed in. Strangers
 * read it — an unfurl crawler, anyone a link is pasted to — and cannot click
 * through to check, so the card either asserts a verdict the run reached or
 * does not exist, and its facts carry nothing the card does not draw.
 */
import { z } from "zod";

import type { CaseVerdict, RunVerdict, SuiteCaseRole, SuiteRunStatus } from "./database-contract-types.ts";
import { isJourneyRole } from "./runtime/case-role-contract.mjs";

/** How many failures the card names; past these it only counts them. */
export const RUN_CARD_NAMED_FAILURES = 2;

/** Everything the card draws. No ids, no passing journey, no evidence. */
export const runCardFactsSchema = z.object({
  outcome: z.enum(["failed", "passed"]),
  projectName: z.string(),
  suiteLabel: z.string(),
  /** The run's journeys; setup and teardown hooks are not counted. */
  total: z.number().int().positive(),
  /** Journeys that failed or errored. */
  failed: z.number().int().nonnegative(),
  /** The first of them to fail, in the order they failed. */
  failedTitles: z.array(z.string()).max(RUN_CARD_NAMED_FAILURES),
  /** When the run finished, to the minute the card prints. */
  completedAt: z.string().datetime(),
}).strict();
export type RunCardFacts = z.output<typeof runCardFactsSchema>;

/** A Case at the attempt its run's page shows. */
export interface RunCardCase {
  role: SuiteCaseRole;
  title: string;
  verdict: CaseVerdict | null;
  completedAt: string | null;
}

function isFailure(journey: Pick<RunCardCase, "verdict">): boolean {
  return journey.verdict === "failed" || journey.verdict === "error";
}

/**
 * The verdict a card may assert, or null. A run still walking, canceled,
 * blocked, or that never reached every journey gets no card at all.
 */
export function runCardOutcome({ status, verdict, journeys }: {
  status: SuiteRunStatus;
  verdict: RunVerdict | null;
  journeys: readonly Pick<RunCardCase, "verdict">[];
}): RunCardFacts["outcome"] | null {
  if (status !== "completed") return null;
  if (journeys.some(isFailure)) return "failed";
  // Green claims a clean bill, so it needs the run's own verdict behind it as
  // well as every journey passing — a blocked or errored run proved less.
  if (verdict === "passed" && journeys.length > 0 && journeys.every((journey) => journey.verdict === "passed")) {
    return "passed";
  }
  return null;
}

/**
 * The card's facts, or null when no honest card exists. Only Journeys count:
 * setup and teardown hooks stay out of the figure. Failures are named in the
 * order they happened, because "which broke first" is what a reader asks when
 * more than one did.
 */
export function runCardFacts(run: {
  status: SuiteRunStatus;
  verdict: RunVerdict | null;
  projectName: string;
  suiteName: string | null;
  createdAt: string;
  completedAt: string | null;
  cases: readonly RunCardCase[];
}): RunCardFacts | null {
  const journeys = run.cases.filter((entry) => isJourneyRole(entry.role));
  const outcome = runCardOutcome({ ...run, journeys });
  if (!outcome) return null;
  const at = (journey: RunCardCase) => Date.parse(journey.completedAt ?? "") || 0;
  const failed = journeys.filter(isFailure).sort((left, right) => at(left) - at(right));
  const finished = Date.parse(run.completedAt ?? run.createdAt);
  return {
    outcome,
    projectName: run.projectName,
    suiteLabel: run.suiteName ?? "Verification run",
    total: journeys.length,
    failed: failed.length,
    failedTitles: failed.slice(0, RUN_CARD_NAMED_FAILURES).map((journey) => journey.title),
    completedAt: new Date(Math.floor(finished / 60_000) * 60_000).toISOString(),
  };
}
