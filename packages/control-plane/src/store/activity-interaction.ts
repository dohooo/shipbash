/**
 * What a person says to a Discovery run that is already going — an
 * instruction to fold into the current pass, the answer to the question it
 * asked — recorded on the Activity, never dropped into a container by the API.
 *
 * The record is the delivery. The heartbeat that renews the leg's lease reads
 * the Activity's control inbox in the same round trip (dispatch-heartbeat.ts)
 * and the leg writes what is new into its own control mount
 * (dispatch-worker-control-inbox.ts).
 * The worker always holds that mount — the service process on a laptop, the
 * task inside the Vercel Sandbox in the cloud — so one path serves both, the
 * API never has to reach a container, and a leg that reconnects finds the
 * record still there. The latency is the heartbeat's: a couple of seconds.
 * The Stop rides the same inbox (store/activity-wrap-up.ts).
 */
import type postgres from "postgres";
import type { SlackLineFacts } from "@shipbash/contracts/slack-line";
import type { SteerImage } from "@shipbash/contracts/steer-images";

import { parseKnowledgeEntry } from "../knowledge.ts";
import { appendActivityEventTransaction, steerRequestedEvent } from "./activity-transactions.ts";
import { type OwedSteer, scopedActivity, wakeForSteer } from "./activities.ts";
import { insertKnowledgeEntry } from "./knowledge.ts";
import { nonEmpty } from "./normalize.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

export interface ActivityScope {
  teamId: string;
  projectId: string;
  activityId: string;
}

/** The question the agent is waiting on, as its choice_request event recorded it. */
export interface PendingActivityQuestion {
  questionId: string;
  prompt: string;
  options: string[];
  allowFreeText: boolean;
}

export interface ActivityAnswer {
  questionId: string;
  option: string | null;
  freeText: string | null;
  note: string | null;
  skipped: boolean;
}

/** Everything the leg owes its control mount, as of one heartbeat (dispatch-heartbeat.ts). */
export interface ActivityControlInbox {
  wrapUpRequested: boolean;
  steers: Array<{ message: string; clientKey: string; requestedAtMs: number }>;
  answer: ActivityAnswer | null;
}

/**
 * Whether the Activity already holds a message under this key, read under the
 * Activity row lock the append takes too, so two deliveries of one message
 * cannot both pass. A chat surface's platform redelivers, and a conversation's
 * opening is its first message's key (start-conversation.ts).
 */
async function holdsSteer(tx: postgres.TransactionSql, input: ActivityScope & { clientKey: string }): Promise<boolean> {
  const rows = await tx`
    select exists (
      select 1 from public.activity_events
      where activity_id = activity.id
        and safe_data ->> 'event' = 'steer_requested'
        and safe_data ->> 'clientKey' = ${nonEmpty(input.clientKey, "clientKey")}
    ) as held
    from public.activities activity
    where activity.id = ${nonEmpty(input.activityId, "activityId")}::uuid
      and activity.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and activity.project_id = ${nonEmpty(input.projectId, "projectId")}
    for update of activity
  `;
  return rows[0]?.held === true;
}

/** A message as the record keeps it. */
interface RecordedMessage extends ActivityScope {
  message: string;
  clientKey: string;
  /** Who said it, as the chat names them. */
  author?: string;
  /** The images the message carries, by reference: never their bytes, which members would read here. */
  images?: readonly SteerImage[];
  /** Where it stands in its Slack thread, when one carried it. */
  slack?: SlackLineFacts;
}

/** The steer_requested a message is recorded as; false when its key is already on record. */
async function appendSteer(tx: postgres.TransactionSql, input: RecordedMessage & { origin?: "report" | "aside" }): Promise<boolean> {
  if (await holdsSteer(tx, input)) return false;
  await appendActivityEventTransaction(tx, {
    teamId: nonEmpty(input.teamId, "teamId"),
    projectId: nonEmpty(input.projectId, "projectId"),
    activityId: nonEmpty(input.activityId, "activityId"),
    ...steerRequestedEvent(input),
  });
  return true;
}

/**
 * A mid-run instruction. The event is both the feed row that keeps the user's
 * bubble across a refresh and the queue: a live leg's heartbeat folds it
 * within seconds, and a queued or parked run's next leg folds it at start
 * (activity-runtime/prepare.ts). A retry repeats its clientKey; the agent is
 * owed one delivery, so a key already on record records nothing and wakes
 * nothing, and the fold acknowledgement carries the same key.
 *
 * The message also rings the bell, in the same transaction, when the
 * Activity sleeps where a message reaches it (wakeForSteer): a delivered
 * conversation wakes, and an Activity of ANY kind parked on a login gate
 * resumes the way a finished sign-in does — every kind parks there, so the
 * door back out is kind-blind. The append holds the Activity row until
 * commit, the lock a leg that completes or parks takes too
 * (store/activity-for-job.ts, store/dispatch-lifecycle.ts), so the guard
 * reads the status that leg leaves: a message recorded before the leg ended
 * is that leg's to wake for, one recorded after it wakes the Activity here,
 * and of two messages to a sleeping Activity only the first moves it.
 * Returns whether this message woke it.
 */
export async function steerActivity(
  tx: postgres.TransactionSql,
  /** origin "report": a message ShipBash composed rather than the owner wrote, a report of work the conversation started. */
  input: RecordedMessage & { origin?: "report" },
): Promise<boolean> {
  return await appendSteer(tx, input) && await wakeForSteer(tx, input, input.clientKey);
}

/**
 * An aside, by `author`: context for the conversation, not a request — a
 * line in its Slack thread by anyone that ShipBash is not to act on
 * (slack-chat/conversation.ts), which carries the line's Slack facts, or
 * ShipBash's own note that the owner stopped a piece of its work
 * (slack-thread-stops.ts), which carries no Slack facts. It rings nothing: it
 * waits, owed, for the turn something else wakes, which reads it as context
 * (conversation-turn/prepare.ts), and a leg that closes never counts it
 * missed (leg-missed-steer.ts).
 */
export async function recordAside(tx: postgres.TransactionSql, input: RecordedMessage & { author: string }): Promise<void> {
  await appendSteer(tx, { ...input, origin: "aside" });
}

/** The acknowledgement undeliveredSteers (activities.ts) looks for: the steer sent under clientKey was answered. */
export function steerFoldedEvent(clientKey: string) {
  return { kind: "lifecycle", label: "Steer folded", bodyMarkdown: null, safeData: { event: "steer_folded", clientKey } } as const;
}

/**
 * These steers the Activity is owed, acknowledged the way a turn acknowledges
 * what it answered. The owner's Stop does this (slack-thread-stops.ts), so a
 * turn claimed after it does not open on them; a message recorded after it
 * is owed as usual.
 */
export async function foldOwedSteers(tx: postgres.TransactionSql, scope: ActivityScope, steers: readonly OwedSteer[]): Promise<void> {
  for (const steer of steers) await appendActivityEventTransaction(tx, { ...scope, ...steerFoldedEvent(steer.clientKey) });
}

function questionFrom(safeData: Record<string, unknown>): PendingActivityQuestion | null {
  const { questionId, prompt, optionsJson, allowFreeText } = safeData;
  if (typeof questionId !== "string" || typeof prompt !== "string") return null;
  let options: unknown = [];
  try {
    options = typeof optionsJson === "string" ? JSON.parse(optionsJson) : [];
  } catch {
    options = [];
  }
  return {
    questionId,
    prompt,
    options: Array.isArray(options) ? options.filter((option): option is string => typeof option === "string") : [],
    allowFreeText: allowFreeText === true,
  };
}

/** What `latestQuestion` reads: the request, whether the record settled it, the answer sent for it. */
export interface OpenQuestionRow {
  request: Record<string, unknown>;
  settled: boolean;
  answer: Record<string, unknown> | null;
}

/**
 * The question the Activity named `activity` by the enclosing query last
 * asked: its choice_request, whether a choice_answered or choice_withdrawn
 * settled it, and the latest choice_answer_submitted naming it. A fragment,
 * read by the API's pending-question check and by the leg's heartbeat in the
 * same round trip as its lease (dispatch-heartbeat.ts).
 */
export function latestQuestion(sql: Queryable): postgres.Fragment {
  return sql`
    select request.safe_data as request,
      exists (
        select 1 from public.activity_events settled
        where settled.activity_id = activity.id and settled.sequence > request.sequence
          and settled.safe_data ->> 'questionId' = request.safe_data ->> 'questionId'
          and settled.safe_data ->> 'event' in ('choice_answered', 'choice_withdrawn')
      ) as settled,
      (
        select sent.safe_data from public.activity_events sent
        where sent.activity_id = activity.id and sent.sequence > request.sequence
          and sent.safe_data ->> 'questionId' = request.safe_data ->> 'questionId'
          and sent.safe_data ->> 'event' = 'choice_answer_submitted'
        order by sent.sequence desc limit 1
      ) as answer
    from public.activity_events request, activity
    where request.activity_id = activity.id and request.team_id = activity.team_id
      and request.project_id = activity.project_id
      and request.safe_data ->> 'event' = 'choice_request'
    order by request.sequence desc limit 1
  `;
}

/** The open question and the answer sent for it, from what `latestQuestion` read; null once settled. */
export function openQuestionFrom(
  row: OpenQuestionRow | null | undefined,
): { question: PendingActivityQuestion; answer: ActivityAnswer | null } | null {
  if (!row || row.settled) return null;
  const question = questionFrom(row.request);
  if (!question) return null;
  const sent = row.answer;
  const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
  return {
    question,
    answer: sent
      ? { questionId: question.questionId, option: text(sent.option), freeText: text(sent.freeText), note: text(sent.note), skipped: sent.skipped === true }
      : null,
  };
}

async function openQuestion(
  sql: Queryable,
  scope: ActivityScope,
): Promise<{ question: PendingActivityQuestion; answer: ActivityAnswer | null } | null> {
  const rows = await sql<OpenQuestionRow[]>`
    with activity as (${scopedActivity(sql, scope)})
    ${latestQuestion(sql)}
  `;
  return openQuestionFrom(rows[0]);
}

/** The question the Activity is waiting on, or null when it is not. */
export async function pendingActivityQuestion(sql: Queryable, scope: ActivityScope): Promise<PendingActivityQuestion | null> {
  const open = await openQuestion(sql, {
    teamId: nonEmpty(scope.teamId, "teamId"),
    projectId: nonEmpty(scope.projectId, "projectId"),
    activityId: nonEmpty(scope.activityId, "activityId"),
  });
  return open?.question ?? null;
}

/**
 * The question the reader still owes an answer: the open question no answer
 * (or skip) was sent for yet. pendingActivityQuestion keeps it open until the
 * leg takes the answer; a sent answer settles it here.
 */
export async function unansweredActivityQuestion(sql: Queryable, scope: ActivityScope): Promise<PendingActivityQuestion | null> {
  const open = await openQuestion(sql, {
    teamId: nonEmpty(scope.teamId, "teamId"),
    projectId: nonEmpty(scope.projectId, "projectId"),
    activityId: nonEmpty(scope.activityId, "activityId"),
  });
  return open && !open.answer ? open.question : null;
}

/**
 * The owner's answer, on the record for the leg to deliver. The knowledge
 * entry lands first, so an answer the agent acts on is one already
 * remembered; a skipped question is deliberately not recorded — "asked and
 * skipped" is not knowledge, and storing it would tell the next run the
 * owner decided something they declined to decide.
 */
export async function answerActivityQuestion(
  tx: postgres.TransactionSql,
  scope: ActivityScope,
  question: PendingActivityQuestion,
  answer: ActivityAnswer,
): Promise<void> {
  const teamId = nonEmpty(scope.teamId, "teamId");
  const projectId = nonEmpty(scope.projectId, "projectId");
  const activityId = nonEmpty(scope.activityId, "activityId");
  if (!answer.skipped) {
    await insertKnowledgeEntry(tx, {
      teamId,
      projectId,
      sourceActivityId: activityId,
      entry: parseKnowledgeEntry({
        kind: "qa",
        entryTitle: question.prompt.slice(0, 120),
        body: {
          question: question.prompt,
          options: question.options,
          answer: answer.option,
          freeText: answer.freeText,
          note: answer.note,
          page: null,
          askedDuring: "discovery",
        },
      }),
      supersedes: null,
    });
  }
  await appendActivityEventTransaction(tx, {
    teamId,
    projectId,
    activityId,
    kind: "lifecycle",
    label: "Answer sent",
    bodyMarkdown: answer.skipped ? "The question was skipped." : answer.option ?? answer.freeText ?? "",
    safeData: {
      event: "choice_answer_submitted",
      phase: "progress",
      questionId: nonEmpty(answer.questionId, "questionId"),
      option: answer.option,
      freeText: answer.freeText,
      note: answer.note,
      skipped: answer.skipped,
    },
  });
}
