import type { Proposal, SuiteDetail, webClient } from "../../lib/web-client";
import { terminalActivities } from "../_lib/activity-derived";
import {
  activeSuites,
  draftJourneyCount,
  pendingProposals,
  projectHooks,
  projectJourneys,
  stagedJourneyEditByCase,
  type ProjectJourney,
  type StagedCaseEdit,
  type StagedJourneyEdit,
} from "../_lib/journeys";
import { resultMark, type ResultMark } from "./shell";

type ActivityIndex = Awaited<ReturnType<typeof webClient.activities>>;
export type LiveActivity = ActivityIndex["activities"][number];
export type StagedByCase = Map<string, StagedCaseEdit>;

/** The mark a Journey or hook carries: an edit since its last walk outranks that walk's verdict. */
export function journeyMark(journey: Pick<ProjectJourney, "verificationState" | "latestVerdict">): ResultMark {
  return journey.verificationState === "unverified" ? "unverified" : resultMark(journey.latestVerdict);
}

/** The categories the Journeys already use, each offered once to the editor. */
export function categoryOptions(journeys: readonly ProjectJourney[]): string[] {
  return [...new Set(journeys.map((journey) => journey.category).filter(Boolean))];
}

/**
 * The walk the live strip points at, if one is under way: any status short of
 * terminal means ShipBash is on the product right now.
 */
export function liveActivity(index: ActivityIndex | undefined): LiveActivity | undefined {
  return index?.activities.find((activity) => !terminalActivities.has(activity.status));
}

interface JourneysPageModel {
  journeys: ProjectJourney[];
  /** Setup and teardown around the journeys; never counted as one. */
  hooks: ProjectJourney[];
  drafts: Proposal[];
  draftCount: number;
  stagedByCase: StagedByCase;
  stagedDrafts: StagedJourneyEdit[];
  runnableSuiteIds: string[];
  /** The active Suite a new hook joins; null before there is one. */
  hookSuite: SuiteDetail | null;
  summary: string;
}

/**
 * Everything the page draws, read off the one journeys response. Keeping it
 * out of the component is what leaves the component a list of gates.
 */
export function journeysPageModel(
  data: { suites: SuiteDetail[]; proposals: Proposal[] },
): JourneysPageModel {
  const suites = activeSuites(data.suites);
  const journeys = projectJourneys(data.suites);
  const drafts = pendingProposals(data.proposals);
  const stagedByCase = stagedJourneyEditByCase(data.proposals, journeys);
  const failing = journeys.filter((journey) => resultMark(journey.latestVerdict) === "failed").length;
  const blocked = journeys.filter((journey) => resultMark(journey.latestVerdict) === "blocked").length;
  return {
    journeys,
    hooks: projectHooks(data.suites),
    drafts,
    draftCount: draftJourneyCount(drafts),
    stagedByCase,
    // Only drafts with a visible staged case reach Verify/Discard.
    stagedDrafts: [...new Set([...stagedByCase.values()].map((entry) => entry.proposal))],
    runnableSuiteIds: suites.map((suite) => suite.id),
    hookSuite: suites[0] ?? null,
    summary: [
      `${String(journeys.length)} ${journeys.length === 1 ? "journey" : "journeys"}`,
      failing ? `${String(failing)} failing` : null,
      blocked ? `${String(blocked)} blocked` : null,
    ].filter(Boolean).join(" · "),
  };
}
