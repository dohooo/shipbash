/**
 * What one finished run should say in a channel that is already mid-
 * conversation, decided without Slack and without Postgres.
 *
 * The rule the whole plan exists to keep: while a subject is red the channel
 * holds exactly one message about it, and everything later is a reply in that
 * message's thread. So the same failing journey produces a run result and its
 * own detail reply the first night and a one-line reply every night after, and
 * the run that finally passes broadcasts a recovery instead of going quiet.
 *
 * Every reply names one journey, so still-failing and recovered are planned
 * per journey, each in that journey's own thread. The sender executes this
 * and decides nothing; the delivery ledger, not the plan, is what keeps a
 * retry from saying anything twice.
 */
import type { SlackAlertSubjectKind } from "@shipbash/contracts/database-contract-types";
import type {
  SlackAlertBlocker,
  SlackAlertDecision,
  SlackAlertJourney,
  SlackAlertView,
} from "./slack-alert-view.ts";

export type { SlackAlertSubjectKind };

/** A message this project still has open about a subject. */
export interface OpenSlackAlertThread {
  id: string;
  subjectKind: SlackAlertSubjectKind;
  subject: string;
  threadTs: string;
  openedAt: string;
  /** The checkpoint the journey stopped at when this thread was last written. */
  lastCheckpoint: string | null;
}

/** One still-red journey, and whether it broke where it broke last time. */
export interface StillFailingEntry {
  threadId: string;
  threadTs: string;
  subject: string;
  title: string;
  /** This run's walk of it, which the reply's button opens. */
  caseRunId: string | null;
  sameCheckpoint: boolean;
  checkpoint: string | null;
  stoppedAtGoal: string | null;
}

/** One journey that came back; its reply closes its thread. */
export interface RecoveredEntry {
  threadId: string;
  threadTs: string;
  subject: string;
  title: string;
  caseRunId: string | null;
  /** When the thread was opened, for "red for 6 hours". */
  openedAt: string;
}

/** Couldn't verify is a first word or a follow-up, never an hourly repeat. */
export type CouldNotVerifyStep =
  | { kind: "open"; blocker: SlackAlertBlocker }
  | { kind: "followUp"; blocker: SlackAlertBlocker; threadId: string; threadTs: string };

export interface SlackAlertPlan {
  /** The journeys that went red with nothing open about them: ② names each, ③ follows for each. */
  newlyFailing: readonly SlackAlertJourney[];
  /** Failed journeys of this run whose thread an earlier run opened: ② counts them. */
  alreadyReported: number;
  stillFailing: readonly StillFailingEntry[];
  recovered: readonly RecoveredEntry[];
  couldNotVerify: CouldNotVerifyStep | null;
  /** Threads that close without a word: a blocker that is no longer the story. */
  closeSilently: readonly string[];
}

/** Nothing to post. The run's outbox row is still settled, just with no message. */
export function planIsSilent(plan: SlackAlertPlan): boolean {
  return (
    plan.newlyFailing.length === 0 &&
    plan.stillFailing.length === 0 &&
    plan.recovered.length === 0 &&
    plan.couldNotVerify === null
  );
}

function threadsBySubject(
  threads: readonly OpenSlackAlertThread[],
  kind: SlackAlertSubjectKind,
): Map<string, OpenSlackAlertThread> {
  return new Map(
    threads.filter((thread) => thread.subjectKind === kind).map((thread) => [thread.subject, thread]),
  );
}

function stillFailingEntry(journey: SlackAlertJourney, thread: OpenSlackAlertThread): StillFailingEntry {
  return {
    threadId: thread.id,
    threadTs: thread.threadTs,
    subject: journey.subject,
    title: journey.title,
    caseRunId: journey.caseRunId,
    // Equal by identity, including both having reached no checkpoint at
    // all: either way nothing moved about where the journey breaks.
    sameCheckpoint: thread.lastCheckpoint === journey.stoppedAtCheckpoint,
    checkpoint: journey.stoppedAtCheckpoint,
    stoppedAtGoal: journey.stoppedAtGoal,
  };
}

function recoveredEntry(journey: SlackAlertJourney, thread: OpenSlackAlertThread): RecoveredEntry {
  return {
    threadId: thread.id,
    threadTs: thread.threadTs,
    subject: journey.subject,
    title: journey.title,
    caseRunId: journey.caseRunId,
    openedAt: thread.openedAt,
  };
}

/**
 * What to post and what to write down. The journey half runs whatever the
 * decision was: a run that could not verify anything may still have passed
 * the journeys it reached, and a journey coming back is worth saying even
 * when the run as a whole proved little.
 *
 * A journey that is neither failed nor passed — blocked, never walked,
 * canceled — leaves its thread exactly as it was and says nothing. No news
 * is not recovery.
 *
 * `postedResultTs` is this run's own run result, when an earlier attempt of
 * this same send posted it. The threads it opened are this run's, not earlier
 * news, so they are read as absent: a retry then plans the very messages the
 * first attempt did, and the ledger skips the ones already said.
 */
export function planSlackAlert(
  view: SlackAlertView,
  decision: SlackAlertDecision | null,
  threads: readonly OpenSlackAlertThread[],
  postedResultTs: string | null,
): SlackAlertPlan {
  const earlier = threads.filter((thread) => thread.threadTs !== postedResultTs);
  const openJourneys = threadsBySubject(earlier, "journey");
  const withThread = view.journeys.flatMap((journey) => {
    const thread = openJourneys.get(journey.subject);
    return thread ? [{ journey, thread }] : [];
  });
  const stillFailing = withThread
    .filter((entry) => entry.journey.verdict === "failed")
    .map((entry) => stillFailingEntry(entry.journey, entry.thread));
  const blocker = decision?.kind === "could_not_verify" ? decision.blocker : null;
  const openBlocker = threadsBySubject(earlier, "blocker");
  return {
    newlyFailing: view.journeys.filter(
      (journey) => journey.verdict === "failed" && !openJourneys.has(journey.subject),
    ),
    alreadyReported: stillFailing.length,
    stillFailing,
    recovered: withThread
      .filter((entry) => entry.journey.verdict === "passed")
      .map((entry) => recoveredEntry(entry.journey, entry.thread)),
    couldNotVerify: blocker === null ? null : couldNotVerifyStep(blocker, openBlocker.get(blocker)),
    // A run that is no longer stopped by a blocker ends its thread quietly:
    // "we can verify again" is not news, and a broadcast would make it so.
    closeSilently: [...openBlocker.values()]
      .filter((thread) => thread.subject !== blocker)
      .map((thread) => thread.id),
  };
}

function couldNotVerifyStep(
  blocker: SlackAlertBlocker,
  open: OpenSlackAlertThread | undefined,
): CouldNotVerifyStep {
  return open
    ? { kind: "followUp", blocker, threadId: open.id, threadTs: open.threadTs }
    : { kind: "open", blocker };
}
