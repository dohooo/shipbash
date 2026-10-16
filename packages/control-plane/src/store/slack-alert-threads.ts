/**
 * The conversation a red subject is holding open in a channel.
 *
 * While a journey is failing the channel holds exactly one message about it
 * and every later result is a reply, so the row that remembers which message
 * is what keeps a journey that stays red from posting once per run. The same
 * shape carries a run that verified nothing: its subject is the blocker, and
 * "still couldn't verify" is a reply rather than an hourly repeat.
 *
 * Each write lands in the same transaction as the ledger row that records its
 * message as posted (`slack-alert-messages.ts`): a message that reached the
 * channel and a thread row that does not remember it is how the same alert
 * gets posted twice.
 *
 * Authorization-blind, like their neighbours: the caller is the system-scoped
 * sender or a proven Team admin's binding write, and every statement is bound
 * to the team.
 */
import type postgres from "postgres";

import type { OpenSlackAlertThread, SlackAlertSubjectKind } from "../slack-alert-plan.ts";
import { iso, nonEmpty } from "./normalize.ts";
import type { SelectedRow, Timestamp } from "./table-rows.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** A subject a run result opens a thread for, under that message's own ts. */
export interface SlackAlertThreadOpening {
  subjectKind: SlackAlertSubjectKind;
  subject: string;
  lastCheckpoint: string | null;
}

/**
 * What one message does to the threads once it is in the channel: the run
 * result opens a thread per subject it names, a still-failing reply moves the
 * checkpoint on, a recovery closes its journey's thread.
 */
export type SlackAlertThreadEffect =
  | { kind: "none" }
  | { kind: "open"; openings: readonly SlackAlertThreadOpening[] }
  | { kind: "checkpoint"; threadId: string; lastCheckpoint: string | null }
  | { kind: "close"; threadId: string };

/** Where the message that carries an effect went. */
export interface SlackAlertThreadMessage {
  teamId: string;
  projectId: string;
  channelId: string;
  /** Null when Slack never said which message it was; nothing can be opened on it. */
  messageTs: string | null;
}

type ThreadRow = SelectedRow<
  "slack_alert_threads",
  "id" | "subject" | "thread_ts" | "last_checkpoint",
  { subject_kind: SlackAlertSubjectKind; opened_at: Timestamp }
>;

/** Every subject this project currently has a message open about in one channel. */
export async function selectOpenSlackAlertThreads(
  sql: Queryable,
  input: { teamId: string; projectId: string; channelId: string },
): Promise<OpenSlackAlertThread[]> {
  const rows = await sql<ThreadRow[]>`
    select id, subject_kind, subject, thread_ts, opened_at, last_checkpoint
    from public.slack_alert_threads
    where team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and project_id = ${nonEmpty(input.projectId, "projectId")}
      and channel_id = ${nonEmpty(input.channelId, "channelId")}
      and closed_at is null
    order by opened_at, id
  `;
  return rows.map((row) => ({
    id: row.id,
    subjectKind: row.subject_kind,
    subject: row.subject,
    threadTs: row.thread_ts,
    openedAt: iso(row.opened_at, "slack_alert_threads.opened_at"),
    lastCheckpoint: row.last_checkpoint,
  }));
}

/**
 * Applies what a message that has reached the channel does to the threads.
 * The caller's transaction is the one that records the message as posted, so
 * the two land together or not at all.
 *
 * Opening is `do nothing` on the partial unique index rather than an upsert:
 * a row already open means another message got there first, and it is the one
 * the channel is reading.
 */
export async function applySlackAlertThreadEffect(
  sql: Queryable,
  message: SlackAlertThreadMessage,
  effect: SlackAlertThreadEffect,
): Promise<void> {
  if (effect.kind === "close") {
    await closeSlackAlertThreads(sql, [effect.threadId]);
    return;
  }
  if (effect.kind === "checkpoint") {
    await sql`
      update public.slack_alert_threads
      set last_checkpoint = ${effect.lastCheckpoint}
      where id = ${nonEmpty(effect.threadId, "threadId")}::uuid and closed_at is null
    `;
    return;
  }
  if (effect.kind === "none" || message.messageTs === null) return;
  for (const opening of effect.openings) {
    await sql`
      insert into public.slack_alert_threads (
        team_id, project_id, subject_kind, subject, channel_id, thread_ts, last_checkpoint
      ) values (
        ${nonEmpty(message.teamId, "teamId")}::uuid, ${nonEmpty(message.projectId, "projectId")},
        ${opening.subjectKind}, ${nonEmpty(opening.subject, "subject")},
        ${nonEmpty(message.channelId, "channelId")}, ${message.messageTs}, ${opening.lastCheckpoint}
      )
      on conflict do nothing
    `;
  }
}

/** The subject is no longer red. Its thread stops collecting replies. */
export async function closeSlackAlertThreads(
  sql: Queryable,
  threadIds: readonly string[],
): Promise<void> {
  if (threadIds.length === 0) return;
  await sql`
    update public.slack_alert_threads
    set closed_at = now()
    where id = any(${sql.array(threadIds.map((id) => nonEmpty(id, "threadId")))}::uuid[])
      and closed_at is null
  `;
}

/**
 * Someone deleted the message a thread hangs from (slack-chat/
 * message-deletion.ts). Whatever it held open stops collecting replies there,
 * so a subject still red opens a thread of its own on its next result rather
 * than answering under a message that is gone. Bound to the teams that
 * connected the workspace the deletion came from.
 */
export async function closeSlackAlertThreadsUnder(
  sql: Queryable,
  input: { slackTeamId: string; channelId: string; threadTs: string },
): Promise<void> {
  await sql`
    update public.slack_alert_threads thread
    set closed_at = now()
    from public.slack_workspaces workspace
    where workspace.slack_team_id = ${nonEmpty(input.slackTeamId, "slackTeamId")}
      and workspace.revoked_at is null
      and thread.team_id = workspace.team_id
      and thread.channel_id = ${nonEmpty(input.channelId, "channelId")}
      and thread.thread_ts = ${nonEmpty(input.threadTs, "threadTs")}
      and thread.closed_at is null
  `;
}

/**
 * The project stopped alerting into this channel. Its open threads there
 * describe a conversation nothing will be posted to again, so they close; its
 * threads in its other channels carry on.
 */
export async function closeSlackAlertChannelThreads(
  sql: Queryable,
  input: { teamId: string; projectId: string; channelId: string },
): Promise<void> {
  await sql`
    update public.slack_alert_threads
    set closed_at = now()
    where team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and project_id = ${nonEmpty(input.projectId, "projectId")}
      and channel_id = ${nonEmpty(input.channelId, "channelId")}
      and closed_at is null
  `;
}
