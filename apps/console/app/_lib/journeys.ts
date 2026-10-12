import type { Route } from "next";

import { awaitsDecision, draftCandidates } from "@shipbash/contracts/draft-decision";

import type { CaseResult, CaseSummary, Proposal, RunSummary, SuiteDetail } from "../../lib/web-client";
import { resultMark, type ResultMark } from "../_components/shell";

/**
 * The journey's recent results as dot-strip entries, oldest first. An edited
 * script overrides the newest dot: until it passes a run again, the freshest
 * signal is "not verified since the edit", not the stale verdict.
 */
export function caseResultDots(journey: Pick<CaseSummary, "recentResults" | "verificationState">): Array<{
  key: string;
  mark: ResultMark;
  title: string;
}> {
  const results = journey.recentResults ?? [];
  // The strip reads left-to-right toward now; the dots fade backwards in time,
  // so the right-most one is the only run at full strength.
  const dots = results.map((result: CaseResult, index: number) => ({
    key: result.caseRunId,
    mark: resultMark(result.verdict),
    title: `${index === results.length - 1 ? "Latest run" : "Run"} · ${new Date(result.runAt).toLocaleString()}`,
  }));
  if (journey.verificationState === "unverified" && dots.length) {
    dots.push({ key: "unverified", mark: "unverified", title: "Since the last edit" });
  }
  return dots;
}

/** A journey plus the suite that carries it — the row shape every surface uses. */
export interface ProjectJourney extends CaseSummary {
  suiteId: string;
  /** The suite's `definitionRevision` as rendered: what a direct write sends back. */
  suiteRevision: number;
}

export function activeSuites(suites: readonly SuiteDetail[]): SuiteDetail[] {
  return suites.filter((suite) => suite.lifecycleStatus === "active");
}

/**
 * Every guarded journey in the project, most important first: `position` ranks
 * importance, and a broken journey surfaces ahead of its equals. The setup
 * and teardown hooks around them are not journeys and live in
 * projectHooks.
 */
export function projectJourneys(suites: readonly SuiteDetail[]): ProjectJourney[] {
  const verdictRank = (verdict: string | null) => (
    verdict === "failed" || verdict === "error" ? 0 : verdict === null ? 1 : 2
  );
  return activeSuites(suites)
    .flatMap((suite) => suite.cases
      .filter((journey) => !journey.archived && journey.role === "journey")
      .map((journey) => ({ ...journey, suiteId: suite.id, suiteRevision: suite.definitionRevision })))
    .sort((left, right) => (
      left.position - right.position
      || verdictRank(left.latestVerdict) - verdictRank(right.latestVerdict)
      || (left.category || "").localeCompare(right.category || "")
      || left.title.localeCompare(right.title)
    ));
}

/** The setup and teardown hooks of the project's active suites, in position order. */
export function projectHooks(suites: readonly SuiteDetail[]): ProjectJourney[] {
  return activeSuites(suites)
    .flatMap((suite) => suite.cases
      .filter((hook) => !hook.archived && hook.role !== "journey")
      .map((hook) => ({ ...hook, suiteId: suite.id, suiteRevision: suite.definitionRevision })))
    .sort((left, right) => left.position - right.position || left.title.localeCompare(right.title));
}

/** "1 m 44 s" — the walk's duration, or an em dash when it never finished. */
export function formatDuration(durationMs: number | null): string {
  if (durationMs === null || durationMs < 0) return "—";
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${String(minutes)} m ${String(seconds)} s` : `${String(seconds)} s`;
}

export function pluralJourneys(count: number): string {
  return count === 1 ? "1 journey" : `${String(count)} journeys`;
}

/**
 * Proposals still waiting on a human decision, by the rule list_journeys
 * lists them by (contracts draft-decision.ts). Journey-edit staging drafts
 * are excluded: they live on the journeys list as staged edits, not in the
 * drafts banner or the Overview drafts row.
 */
export function pendingProposals(proposals: readonly Proposal[]): Proposal[] {
  return proposals.filter(awaitsDecision);
}

/** The latest walk of the Suite's staged edits; while there is one, the edits hold still. */
export function stagedEditsWalk(proposals: readonly Proposal[], suiteId: string): Proposal["walk"] {
  return stagedJourneyEdits(proposals).find((draft) => draft.targetSuiteId === suiteId)?.walk ?? null;
}

/** A journey-edit staging draft: one per suite, instructions keyed by case. */
export type StagedJourneyEdit = Proposal & { journeyEditInstructions: Record<string, string> };

/** The suite-level drafts holding staged journey edits. */
function stagedJourneyEdits(proposals: readonly Proposal[]): StagedJourneyEdit[] {
  return proposals.filter((proposal): proposal is StagedJourneyEdit => (
    proposal.status === "draft" && Boolean(proposal.journeyEditInstructions)
  ));
}

/** One journey's staged edit: the staging draft holding it and the instruction said with it. */
export interface StagedCaseEdit {
  proposal: StagedJourneyEdit;
  instruction: string;
}

/**
 * Staged edits addressed by case id — the chips, counts and modal prefill
 * read this. Scoped to the visible journeys so a draft entry whose case was
 * archived after staging never counts as a pending edit.
 */
export function stagedJourneyEditByCase(
  proposals: readonly Proposal[],
  journeys: ReadonlyArray<{ id: string }>,
): Map<string, StagedCaseEdit> {
  const visible = new Set(journeys.map((journey) => journey.id));
  const staged = new Map<string, StagedCaseEdit>();
  for (const proposal of stagedJourneyEdits(proposals)) {
    for (const [caseId, instruction] of Object.entries(proposal.journeyEditInstructions)) {
      if (visible.has(caseId)) staged.set(caseId, { proposal, instruction });
    }
  }
  return staged;
}

/** One row of the Overview's "Needs attention" list, whichever source raised it. */
export interface AttentionItem {
  id: string;
  title: string;
  body: string;
  actionLabel: string;
  href: Route;
}

/** Overview row for staged edits: unverified until an Edit run proves them. */
export function stagedEditAttentionItems(
  proposals: readonly Proposal[],
  journeys: ReadonlyArray<{ id: string }>,
  teamHref: (pathname: string) => Route,
): AttentionItem[] {
  const count = stagedJourneyEditByCase(proposals, journeys).size;
  if (!count) return [];
  return [{
    id: "staged-edits",
    title: `${String(count)} edited ${count === 1 ? "journey is" : "journeys are"} unverified`,
    body: "The scripts changed and have not passed a run yet, so they stay out of the schedule.",
    actionLabel: "Verify edits",
    href: teamHref("/journeys"),
  }];
}

/** Overview rows for runs paused at a sign-in wall, waiting on a human. */
export function takeoverAttentionItems(
  runs: readonly RunSummary[],
  teamHref: (pathname: string) => Route,
): AttentionItem[] {
  return runs
    .filter((run) => run.status === "waiting_for_auth")
    .map((run) => ({
      id: `run-auth-${run.id}`,
      title: `Sign-in needed · ${run.suiteName ?? "a verification"}`,
      body: "The walk paused at the sign-in wall. Take control in a session, then the run resumes.",
      actionLabel: "Take control",
      href: teamHref(`/verifications/${encodeURIComponent(run.id)}/takeover`),
    }));
}

/** The soonest scheduled run across the project's suites, if any is scheduled. */
export function nextScheduledRunAt(suites: readonly SuiteDetail[]): string | null {
  const upcoming = activeSuites(suites)
    .map((suite) => suite.schedule?.nextRunAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  return upcoming[0] ?? null;
}

/** Draft journeys awaiting a decision, across the given reviews: never the approved Journeys a change carries as they are. */
export function draftJourneyCount(proposals: readonly Proposal[]): number {
  return proposals.reduce((total, proposal) => total + draftCandidates(proposal).length, 0);
}
