/**
 * The delivery ledger: one row per Slack message a run's alert intends to
 * post in one channel, keyed by the run, the channel and a key that stays the
 * same across retries. It is what lets a send of 1 + N messages be retried
 * without saying anything twice.
 *
 *   (absent | failed) -> posting -> sent | failed | unknown
 *
 * A key is written `posting` just before the one call that makes its message
 * visible, and settled from there. `sent` and `unknown` are final: an unknown
 * outcome is never retried, because a second post is worse than a missing
 * one. A `posting` row older than the stale window belongs to a sender that
 * died mid-call, so it is abandoned as `unknown` rather than tried again.
 *
 * Authorization-blind, like their neighbours: the caller is the system-scoped
 * sender, and every row carries the team and project it belongs to.
 */
import type postgres from "postgres";

import type { SlackAlertMessageState } from "@shipbash/contracts/database-contract-types";
import { recordAside } from "./activity-interaction.ts";
import { nonEmpty } from "./normalize.ts";
import { type SlackAlertThreadEffect, applySlackAlertThreadEffect } from "./slack-alert-threads.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/**
 * Every message a run can post, by the key the ledger holds it under. A key
 * is the same on every retry of the run, which is what lets a retry tell a
 * message already said from one still owed.
 */
export const slackAlertMessageKey = {
  /** The run result. Its `ts` is what every detail reply is threaded under. */
  result: () => "result",
  detail: (subject: string) => `detail:${subject}`,
  /** The evidence command under a detail reply's recording. */
  handoff: (subject: string) => `handoff:${subject}`,
  stillFailing: (subject: string) => `still_failing:${subject}`,
  recovered: (subject: string) => `recovered:${subject}`,
  blocker: (blocker: string) => `blocker:${blocker}`,
} as const;

/** Where one intended message goes, and under which key. */
export interface SlackAlertMessageAddress {
  runId: string;
  key: string;
  teamId: string;
  projectId: string;
  channelId: string;
  /** The message this one replies under; null for the run result itself. */
  threadTs: string | null;
}

/** What the ledger holds for one key, read before anything is prepared. */
export type SlackAlertMessageRecord =
  | { state: "absent" | "failed" | "unknown" }
  | { state: "sent"; messageTs: string | null }
  | { state: "posting"; stale: boolean };

/**
 * How the one call that makes a message visible ended. A message sent short
 * of what it meant to carry — a reply that went out without its video — says
 * why in `note`, which the ledger keeps in its `error` column.
 */
export type SlackAlertMessageOutcome =
  | { state: "sent"; messageTs: string | null; note: string | null }
  | { state: "failed" | "unknown"; error: string };

export async function selectSlackAlertMessage(
  sql: Queryable,
  input: { runId: string; channelId: string; key: string; staleSeconds: number },
): Promise<SlackAlertMessageRecord> {
  const rows = await sql<Array<{ state: SlackAlertMessageState; message_ts: string | null; stale: boolean }>>`
    select state, message_ts,
      attempted_at < clock_timestamp() - make_interval(secs => ${input.staleSeconds}::double precision) as stale
    from public.slack_alert_messages
    where suite_run_id = ${nonEmpty(input.runId, "runId")}
      and channel_id = ${nonEmpty(input.channelId, "channelId")}
      and message_key = ${nonEmpty(input.key, "key")}
  `;
  const row = rows[0];
  if (!row) return { state: "absent" };
  if (row.state === "sent") return { state: "sent", messageTs: row.message_ts };
  if (row.state === "posting") return { state: "posting", stale: row.stale };
  return { state: row.state };
}

/**
 * Takes the key for one post. It succeeds only from absent or `failed`, so of
 * two senders racing for the same message exactly one is allowed to make it
 * visible, and a key already posted or of unknown fate is never taken again.
 */
export async function beginSlackAlertMessage(
  sql: Queryable,
  address: SlackAlertMessageAddress,
): Promise<boolean> {
  const rows = await sql`
    insert into public.slack_alert_messages as message (
      suite_run_id, message_key, team_id, project_id, channel_id, thread_ts, state
    ) values (
      ${nonEmpty(address.runId, "runId")}, ${nonEmpty(address.key, "key")},
      ${nonEmpty(address.teamId, "teamId")}::uuid, ${nonEmpty(address.projectId, "projectId")},
      ${nonEmpty(address.channelId, "channelId")}, ${address.threadTs}, 'posting'
    )
    on conflict (suite_run_id, channel_id, message_key) do update
    set state = 'posting', thread_ts = excluded.thread_ts,
      attempted_at = now(), settled_at = null, message_ts = null, error = null
    where message.state = 'failed'
    returning 1
  `;
  return rows.length > 0;
}

/**
 * ShipBash's own alert posted into a thread a conversation holds: an aside on
 * that conversation, its words as Slack's notification line gives them, so
 * the next turn reads it as context — added after what the turns have read,
 * never a re-telling of it. A thread no conversation holds takes nothing.
 */
async function alertAside(
  sql: postgres.TransactionSql,
  address: SlackAlertMessageAddress & { slackTeamId: string },
  said: string,
): Promise<void> {
  if (!address.threadTs) return;
  // The thread by Slack's own key; it is this alert's only while its conversation is on the alert's project.
  const [thread] = await sql<Array<{ activity_id: string }>>`
    select activity_id::text from public.slack_threads
    where slack_team_id = ${nonEmpty(address.slackTeamId, "slackTeamId")}
      and channel_id = ${nonEmpty(address.channelId, "channelId")} and thread_ts = ${address.threadTs}
      and team_id = ${nonEmpty(address.teamId, "teamId")}::uuid and project_id = ${nonEmpty(address.projectId, "projectId")}
  `;
  if (!thread) return;
  await recordAside(sql, {
    teamId: address.teamId,
    projectId: address.projectId,
    activityId: thread.activity_id,
    clientKey: `alert:${address.runId}:${address.key}`,
    message: said,
    author: "ShipBash alert",
  });
}

/**
 * Records how the post ended, and — for a message that is or may be in the
 * channel — applies what it does to the threads in the same transaction. Only
 * a key still `posting` is settled: one abandoned meanwhile stays abandoned.
 */
export async function settleSlackAlertMessage(
  sql: postgres.Sql,
  input: {
    address: SlackAlertMessageAddress;
    outcome: SlackAlertMessageOutcome;
    effect: SlackAlertThreadEffect;
    /** The Slack workspace it was posted in. */
    slackTeamId: string;
    /** The message's notification line, which a conversation holding its thread reads as an aside. */
    said: string;
  },
): Promise<void> {
  const { address, outcome } = input;
  const messageTs = outcome.state === "sent" ? outcome.messageTs : null;
  const error = (outcome.state === "sent" ? outcome.note : outcome.error)?.slice(0, 2_000) ?? null;
  await sql.begin(async (sql) => {
    const settled = await sql`
      update public.slack_alert_messages
      set state = ${outcome.state}, message_ts = ${messageTs}, error = ${error}, settled_at = now()
      where suite_run_id = ${nonEmpty(address.runId, "runId")}
        and channel_id = ${nonEmpty(address.channelId, "channelId")}
        and message_key = ${nonEmpty(address.key, "key")}
        and state = 'posting'
      returning 1
    `;
    if (settled.length === 0 || outcome.state === "failed") return;
    await applySlackAlertThreadEffect(sql, { ...address, messageTs }, input.effect);
    await alertAside(sql, { ...address, slackTeamId: input.slackTeamId }, input.said);
  });
}

/**
 * A `posting` row older than the stale window: its sender died somewhere
 * around the call, so whether the message landed cannot be known. It becomes
 * `unknown` — and its effect is applied as if it had landed, because a
 * repeat is the worse mistake — and false means another sender got there
 * first or the row was not stale after all.
 */
export async function abandonSlackAlertMessage(
  sql: postgres.Sql,
  input: {
    address: SlackAlertMessageAddress;
    staleSeconds: number;
    effect: SlackAlertThreadEffect;
  },
): Promise<boolean> {
  const { address } = input;
  return await sql.begin(async (sql) => {
    const abandoned = await sql`
      update public.slack_alert_messages
      set state = 'unknown', settled_at = now(),
        error = 'The sender stopped before Slack answered; delivery is uncertain.'
      where suite_run_id = ${nonEmpty(address.runId, "runId")}
        and channel_id = ${nonEmpty(address.channelId, "channelId")}
        and message_key = ${nonEmpty(address.key, "key")}
        and state = 'posting'
        and attempted_at < clock_timestamp() - make_interval(secs => ${input.staleSeconds}::double precision)
      returning 1
    `;
    if (abandoned.length === 0) return false;
    await applySlackAlertThreadEffect(sql, { ...address, messageTs: null }, input.effect);
    return true;
  });
}

/**
 * The `ts` of this run's own run result in one channel, once the ledger holds
 * it as sent. A retry reads the threads that message opened as its own, not
 * as earlier news.
 */
export async function selectPostedResultTs(
  sql: Queryable,
  input: { runId: string; channelId: string },
): Promise<string | null> {
  const rows = await sql<Array<{ message_ts: string | null }>>`
    select message_ts
    from public.slack_alert_messages
    where suite_run_id = ${nonEmpty(input.runId, "runId")}
      and channel_id = ${nonEmpty(input.channelId, "channelId")}
      and message_key = ${slackAlertMessageKey.result()}
      and state = 'sent'
  `;
  return rows[0]?.message_ts ?? null;
}
