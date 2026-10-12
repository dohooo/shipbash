"use client";

import type { Route } from "next";

import type { ActivityDetail, Proposal, RunSummary, SuiteDetail, TeamSignIn, webClient } from "../../lib/web-client";
import { proposalsReviewHref, stoppedActivityId } from "../_lib/activity-derived";
import { failedTeardownItems } from "../_lib/journey-hooks";
import {
  type AttentionItem,
  type ProjectJourney,
  draftJourneyCount,
  nextScheduledRunAt,
  pendingProposals,
  pluralJourneys,
  projectHooks,
  projectJourneys,
  stagedEditAttentionItems,
  takeoverAttentionItems,
} from "../_lib/journeys";
import { authAttentionItems } from "./auth-attention";
import { signInAttentionItems } from "./sign-in-attention";
import { journeysByOutcome, faultedAttentionItems } from "./run-outcome-attention";
import { type SlackConnections, slackAttentionItems } from "./slack-attention";
import { resultMark } from "./shell";

/** What the reader is being told, in the order the hero decides it. */
export interface HeroState {
  alerting: boolean;
  firstDay: boolean;
  failingCount: number;
  journeyCount: number;
  passing: number;
  /** Open items in Needs attention. A green summary above one is a lie. */
  attentionCount: number;
  verifiedAt: string | null;
  productionUrl: string | null;
}

type ActivitySummary = Awaited<ReturnType<typeof webClient.activities>>["activities"][number];
type AuthProfile = Awaited<ReturnType<typeof webClient.overview>>["authProfile"];
type TeamHref = (pathname: string) => Route;

function authProfileItems(authProfile: AuthProfile, teamHref: TeamHref): AttentionItem[] {
  if (!authProfile || (authProfile.status !== "expired" && authProfile.status !== "failed")) return [];
  return [{
    id: "auth-profile",
    title: authProfile.status === "expired"
      ? "The test account session expired"
      : "The test account sign-in failed",
    // An expired session signs no run in; a sign-in that could not be saved
    // leaves the one saved before it, which a hosted run still starts from.
    body: authProfile.status === "expired"
      ? "The next run will pause and ask you to sign in again — run now to get it out of the way."
      : "A sign-in a run verified could not be saved, so the next run may pause and ask you to sign in again.",
    actionLabel: "Go to journeys",
    href: teamHref("/journeys"),
  }];
}

function waitingActivityItems(
  activities: readonly ActivitySummary[],
  teamHref: TeamHref,
): AttentionItem[] {
  const waiting = activities.find((activity) => activity.status === "waiting_for_auth");
  if (!waiting) return [];
  return [{
    id: `activity-${waiting.id}`,
    title: "Exploration is waiting on one decision",
    body: "A sign-in or a choice only you can make.",
    actionLabel: "Watch live",
    href: teamHref(`/activities/${encodeURIComponent(waiting.id)}`),
  }];
}

/** A stopped exploration's card, with the pending proposals the card speaks for. */
interface StoppedExploration {
  items: AttentionItem[];
  claimed: ReadonlySet<string>;
}

/**
 * An exploration that ended needing the reader is over — nothing is waiting
 * live. When it kept Journeys the reader has not decided on yet (its time
 * budget ran out, say), the item is those Journeys and leads to their
 * review, and the drafts card leaves them to it. Kept Journeys already kept
 * or discarded need nothing more — the run stays needs_attention forever,
 * so the card must not. A run that kept nothing leads to itself, whose
 * result says what stopped it. `stopped` is that run's detail, loaded by
 * the page only when such an Activity exists.
 */
function stoppedActivityItems(
  activities: readonly ActivitySummary[],
  stopped: ActivityDetail | null,
  teamHref: TeamHref,
): StoppedExploration {
  const id = stoppedActivityId(activities);
  if (!id) return { items: [], claimed: new Set() };
  const result = stopped?.id === id ? stopped.result : null;
  const pending = pendingProposals(result?.proposals ?? []);
  const kept = draftJourneyCount(pending);
  const reviewHref = kept > 0 ? proposalsReviewHref(pending, teamHref) : null;
  if (reviewHref) {
    return {
      items: [{
        id: `activity-${id}`,
        title: `Exploration stopped with ${pluralJourneys(kept)} to review`,
        body: "Stopped at its time budget or a blocker; what it found is kept.",
        actionLabel: "Review",
        href: reviewHref,
      }],
      claimed: new Set(pending.map((proposal) => proposal.id)),
    };
  }
  if (result && result.proposals.length > 0) return { items: [], claimed: new Set() };
  return {
    items: [{
      id: `activity-${id}`,
      title: "Exploration stopped and needs you",
      body: result?.recoveryAction ?? "Open the run to see what stopped it.",
      actionLabel: "See why",
      href: teamHref(`/activities/${encodeURIComponent(id)}`),
    }],
    claimed: new Set(),
  };
}

function blockedItems(blocked: readonly ProjectJourney[], teamHref: TeamHref): AttentionItem[] {
  if (!blocked.length) return [];
  return [{
    id: "blocked",
    title: `${pluralJourneys(blocked.length)} could not be walked`,
    body: "The environment blocked the run — a sign-in, a gate or a missing precondition. No failure was raised.",
    actionLabel: "See which",
    href: teamHref("/journeys"),
  }];
}

function unverifiedItems(unverified: readonly ProjectJourney[], teamHref: TeamHref): AttentionItem[] {
  if (!unverified.length) return [];
  const only = unverified.length === 1 ? unverified[0] : undefined;
  return [{
    id: "unverified",
    title: `${String(unverified.length)} edited ${unverified.length === 1 ? "journey is" : "journeys are"} unverified`,
    body: "The script changed and has not passed a run yet, so it stays out of the schedule.",
    actionLabel: unverified.length === 1 ? "Run it once" : "See which",
    href: only
      ? teamHref(`/journeys/${encodeURIComponent(only.id)}`)
      : teamHref("/journeys"),
  }];
}

function draftItems(
  drafts: readonly Proposal[],
  draftCount: number,
  teamHref: TeamHref,
): AttentionItem[] {
  if (!draftCount) return [];
  const only = drafts.length === 1 ? drafts[0] : undefined;
  return [{
    id: "drafts",
    title: `${String(draftCount)} draft ${draftCount === 1 ? "journey is" : "journeys are"} waiting for you`,
    body: "From the last exploration — keep, edit or discard each.",
    actionLabel: "Review drafts",
    href: only
      ? teamHref(`/proposals/${encodeURIComponent(only.id)}`)
      : teamHref("/proposals"),
  }];
}

/**
 * Everything asking for the reader, in the order the page states it: a run
 * paused at a wall first, then the sign-in that will pause the next one, then
 * what ShipBash broke, then what is only waiting on a decision. Each block
 * stays empty until it has something to say.
 */
function overviewAttention(input: {
  recentRuns: readonly RunSummary[];
  authProfile: AuthProfile;
  /** The ways into this product; a paused one is the only notice a pause gets. */
  signIns: readonly TeamSignIn[];
  activities: readonly ActivitySummary[];
  stoppedActivity: ActivityDetail | null;
  faulted: readonly ProjectJourney[];
  authAttention: Awaited<ReturnType<typeof webClient.authAttention>>["items"];
  /** Where this project's failures are announced, and whether they still are. */
  slackConnections: SlackConnections | undefined;
  project: { id: string };
  blocked: readonly ProjectJourney[];
  /** The setup and teardown hooks; a failed teardown is the only one that asks. */
  hooks: readonly ProjectJourney[];
  proposals: readonly Proposal[];
  journeys: readonly ProjectJourney[];
  unverified: readonly ProjectJourney[];
  drafts: readonly Proposal[];
  teamHref: TeamHref;
}): AttentionItem[] {
  const { teamHref } = input;
  const stopped = stoppedActivityItems(input.activities, input.stoppedActivity, teamHref);
  const drafts = input.drafts.filter((proposal) => !stopped.claimed.has(proposal.id));
  return [
    ...takeoverAttentionItems(input.recentRuns, teamHref),
    ...authProfileItems(input.authProfile, teamHref),
    ...signInAttentionItems(input.signIns, teamHref),
    ...authAttentionItems(input.authAttention, teamHref),
    ...slackAttentionItems(input.slackConnections, input.project, teamHref),
    ...waitingActivityItems(input.activities, teamHref),
    ...stopped.items,
    ...faultedAttentionItems(input.faulted, teamHref),
    ...blockedItems(input.blocked, teamHref),
    ...failedTeardownItems(input.hooks, teamHref),
    ...stagedEditAttentionItems(input.proposals, input.journeys, teamHref),
    ...unverifiedItems(input.unverified, teamHref),
    ...draftItems(drafts, draftJourneyCount(drafts), teamHref),
  ];
}

/**
 * Everything the Overview shows, from the three responses it reads. The hero
 * verdict, the needs-attention list and the last-run row are derived together
 * because they answer one question between them, and a page that counted them
 * separately could contradict itself.
 */
export function overviewModel(input: {
  overview: Awaited<ReturnType<typeof webClient.overview>>;
  signIns: readonly TeamSignIn[];
  suites: readonly SuiteDetail[];
  proposals: readonly Proposal[];
  activities: readonly ActivitySummary[];
  activitiesFailed: boolean;
  /** The detail of the Activity that ended needing the reader, once loaded. */
  stoppedActivity: ActivityDetail | null;
  authAttention: Awaited<ReturnType<typeof webClient.authAttention>>["items"];
  slackConnections: SlackConnections | undefined;
  /** A failed Slack read hides a silence, which is the one thing it must not do. */
  slackFailed: boolean;
  project: { id: string };
  productionUrl: string | null;
  teamHref: TeamHref;
}) {
  const journeys = projectJourneys(input.suites);
  const drafts = pendingProposals(input.proposals);
  const { failing, faulted } = journeysByOutcome(journeys);
  const blocked = journeys.filter((journey) => resultMark(journey.latestVerdict) === "blocked");
  const passing = journeys.filter((journey) => resultMark(journey.latestVerdict) === "passed").length;
  const verifiedAt = journeys
    .map((journey) => journey.latestRunAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const latestRun = input.overview.recentRuns[0] ?? null;
  const brokenRun = input.overview.recentRuns.find(
    (run) => run.verdict === "failed" || run.verdict === "error",
  ) ?? null;
  const attention = overviewAttention({
    recentRuns: input.overview.recentRuns,
    authProfile: input.overview.authProfile,
    signIns: input.signIns,
    activities: input.activities,
    stoppedActivity: input.stoppedActivity,
    faulted,
    authAttention: input.authAttention,
    slackConnections: input.slackConnections,
    project: input.project,
    blocked,
    hooks: projectHooks(input.suites),
    proposals: input.proposals,
    journeys,
    unverified: journeys.filter((journey) => journey.verificationState === "unverified"),
    drafts,
    teamHref: input.teamHref,
  });
  // The verdict is derived after the list, not beside it: the badge has to
  // know whether anything is asking for the reader before it can say so.
  const hero: HeroState = {
    alerting: failing.length > 0,
    firstDay: journeys.length === 0,
    failingCount: failing.length,
    journeyCount: journeys.length,
    passing,
    attentionCount: attention.length,
    verifiedAt,
    productionUrl: input.productionUrl,
  };
  return {
    hero,
    attention,
    // A failed fetch of anything this list is built from must not read as
    // "nothing needs you" — least of all Slack's, whose whole item is the
    // notice nobody noticed.
    attentionUnknown: input.activitiesFailed || input.slackFailed,
    latestRun,
    latestRunHref: latestRun
      ? input.teamHref(`/verifications/${encodeURIComponent(latestRun.id)}`)
      : null,
    // Failing without a run that proves it sends the reader to the list instead.
    brokenRunHref: brokenRun
      ? input.teamHref(`/verifications/${encodeURIComponent(brokenRun.id)}`)
      : input.teamHref("/journeys"),
    nextRunAt: nextScheduledRunAt(input.suites),
  };
}
