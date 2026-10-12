/**
 * Posting one plan: which messages it means, under which keys, in what order.
 * Each message then goes through the delivery ledger on its own
 * (`slack-alert-post-message.ts`), which is what keeps a retry from saying
 * anything twice.
 *
 * The order: replies into threads earlier runs opened, then the run result,
 * then its detail replies, which need the result's `ts` to thread under,
 * each followed by the evidence command for its walk (template ④). A
 * reply Slack refuses for itself alone is recorded and the rest still go out.
 */
import type { ConsoleLinks } from "./console-links.ts";
import {
  replyFailedJourney,
  replyHandoff,
  replyRecovered,
  replyStillCouldNotVerify,
  replyStillFailing,
  runResultCouldNotVerify,
  runResultFailed,
} from "./slack-alert-messages.ts";
import {
  type PlannedMessage,
  type SlackAlertMessageDependencies,
  type SlackAlertMessageRoute,
  deliverPlannedMessage,
} from "./slack-alert-post-message.ts";
import type { SlackAlertPlan } from "./slack-alert-plan.ts";
import type { SlackAlertView } from "./slack-alert-view.ts";
import type { SlackAlertContext } from "./store/slack-alert-context.ts";
import { slackAlertMessageKey } from "./store/slack-alert-messages.ts";
import type { SlackAlertThreadEffect } from "./store/slack-alert-threads.ts";

export interface SlackAlertPostingDependencies extends SlackAlertMessageDependencies {
  publicOrigin: string;
}

export interface SlackAlertPosting extends SlackAlertMessageRoute {
  context: SlackAlertContext;
  view: SlackAlertView;
  plan: SlackAlertPlan;
}

/**
 * How a plan's posting ended when nothing stopped the row. The run result
 * decides it: `uncertain` means its post has an unknowable outcome, so there
 * is no `ts` to reply under; `refused` means Slack turned it down for itself.
 * Either way its detail replies were never sent.
 */
export type SlackAlertPostingOutcome =
  | { kind: "sent" }
  | { kind: "uncertain"; method: string }
  | { kind: "refused"; error: string };

const NO_EFFECT: SlackAlertThreadEffect = { kind: "none" };

export async function postSlackAlertPlan(
  dependencies: SlackAlertPostingDependencies,
  posting: SlackAlertPosting,
): Promise<SlackAlertPostingOutcome> {
  const links: ConsoleLinks = {
    publicOrigin: dependencies.publicOrigin,
    teamSlug: posting.context.teamSlug,
    projectSlug: posting.context.projectSlug,
  };
  for (const message of repliesToEarlierThreads(posting, links)) {
    await deliverPlannedMessage(dependencies, posting, message);
  }
  const result = runResult(posting, links);
  if (result === null) return { kind: "sent" };
  const delivered = await deliverPlannedMessage(dependencies, posting, result);
  if (delivered.kind === "refused") return { kind: "refused", error: delivered.error.message };
  if (delivered.kind === "unknown" || delivered.ts === null) {
    return { kind: "uncertain", method: "chat.postMessage" };
  }
  for (const message of detailReplies(posting, links, delivered.ts)) {
    await deliverPlannedMessage(dependencies, posting, message);
  }
  return { kind: "sent" };
}

/** The clock a recovery is measured to. */
function observedAt(posting: SlackAlertPosting): string {
  return posting.context.detail.run.completedAt ?? posting.view.triggeredAt;
}

/** Still failing and recovered, one per journey, then the blocker's follow-up. */
function repliesToEarlierThreads(posting: SlackAlertPosting, links: ConsoleLinks): PlannedMessage[] {
  const { plan, view } = posting;
  const runId = view.runId;
  const messages: PlannedMessage[] = [
    ...plan.stillFailing.map((entry): PlannedMessage => ({
      key: slackAlertMessageKey.stillFailing(entry.subject),
      threadTs: entry.threadTs,
      payload: replyStillFailing({ journey: entry, runId, links }),
      replyBroadcast: false,
      replay: null,
      effect: { kind: "checkpoint", threadId: entry.threadId, lastCheckpoint: entry.checkpoint },
    })),
    ...plan.recovered.map((entry): PlannedMessage => ({
      key: slackAlertMessageKey.recovered(entry.subject),
      threadTs: entry.threadTs,
      payload: replyRecovered({
        journey: entry,
        runId,
        links,
        openedAt: entry.openedAt,
        passedAt: observedAt(posting),
      }),
      // The one reply worth showing people who never opened the thread.
      replyBroadcast: true,
      replay: null,
      effect: { kind: "close", threadId: entry.threadId },
    })),
  ];
  const step = plan.couldNotVerify;
  if (step?.kind === "followUp") {
    messages.push({
      key: slackAlertMessageKey.blocker(step.blocker),
      threadTs: step.threadTs,
      payload: replyStillCouldNotVerify({ view, blocker: step.blocker }),
      replyBroadcast: false,
      replay: null,
      effect: NO_EFFECT,
    });
  }
  return messages;
}

/**
 * The run result, which opens the thread its subjects are held under. A run
 * either has newly failing journeys or could not verify — the classifier
 * never says both — so this is at most one message.
 */
function runResult(posting: SlackAlertPosting, links: ConsoleLinks): PlannedMessage | null {
  const { plan, view } = posting;
  const opening = { key: slackAlertMessageKey.result(), threadTs: null, replyBroadcast: false, replay: null };
  if (plan.newlyFailing.length > 0) {
    return {
      ...opening,
      payload: runResultFailed({ view, listed: plan.newlyFailing, alreadyReported: plan.alreadyReported, links }),
      effect: {
        kind: "open",
        openings: plan.newlyFailing.map((journey) => ({
          subjectKind: "journey" as const,
          subject: journey.subject,
          lastCheckpoint: journey.stoppedAtCheckpoint,
        })),
      },
    };
  }
  const step = plan.couldNotVerify;
  if (step?.kind !== "open") return null;
  return {
    ...opening,
    payload: runResultCouldNotVerify({ view, blocker: step.blocker, links }),
    effect: { kind: "open", openings: [{ subjectKind: "blocker", subject: step.blocker, lastCheckpoint: null }] },
  };
}

/**
 * One reply per journey the run result lists, in its order, each with its
 * replay, and under each one whose walk ran, the command that pulls that
 * walk's evidence.
 */
function detailReplies(
  posting: SlackAlertPosting,
  links: ConsoleLinks,
  resultTs: string,
): PlannedMessage[] {
  const runId = posting.view.runId;
  return posting.plan.newlyFailing.flatMap((journey, index): PlannedMessage[] => {
    const detail: PlannedMessage = {
      key: slackAlertMessageKey.detail(journey.subject),
      threadTs: resultTs,
      payload: replyFailedJourney({ journey, runId, links }),
      replyBroadcast: false,
      replay: journey.caseRunId === null
        ? null
        : { caseRunId: journey.caseRunId, title: journey.title, position: index + 1 },
      effect: NO_EFFECT,
    };
    if (journey.caseRunId === null) return [detail];
    return [detail, {
      key: slackAlertMessageKey.handoff(journey.subject),
      threadTs: resultTs,
      payload: replyHandoff(journey.caseRunId),
      replyBroadcast: false,
      replay: null,
      effect: NO_EFFECT,
    }];
  });
}
