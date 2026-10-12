/**
 * The Slack threads @ShipBash converses in, each bound to the one conversation
 * Activity its messages steer. The conversation's turn posts its own replies
 * (conversation-turn/reply.ts).
 *
 * Authorization-blind, like their neighbours: the bot answers Slack, whose
 * signature names the workspace.
 */
import type postgres from "postgres";
import { type ThreadLine, slackLineFacts } from "@shipbash/contracts/slack-line";

import type { ActivitySummary } from "../types.ts";
import { nonEmpty } from "./normalize.ts";
import { linkedSlackUser } from "./slack-user-links.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** Where a thread is in Slack. */
export interface SlackThreadAddress {
  slackTeamId: string;
  channelId: string;
  threadTs: string;
}

/** A thread's conversation, as a new message in it needs it. */
export interface SlackThreadConversation {
  threadId: string;
  teamId: string;
  teamSlug: string;
  projectId: string;
  projectSlug: string;
  activityId: string;
  activityKind: string;
  activityStatus: ActivitySummary["status"];
}

export async function selectSlackThread(
  sql: Queryable,
  address: SlackThreadAddress,
): Promise<SlackThreadConversation | null> {
  const rows = await sql<Array<{
    id: string;
    team_id: string;
    team_slug: string;
    project_id: string;
    project_slug: string;
    activity_id: string;
    kind: string;
    status: ActivitySummary["status"];
  }>>`
    select thread.id, thread.team_id, team.slug as team_slug, thread.project_id, project.slug as project_slug,
      thread.activity_id, activity.kind, activity.status
    from public.slack_threads thread
    join public.activities activity on activity.id = thread.activity_id
    join public.teams team on team.id = thread.team_id
    join public.projects project on project.id = thread.project_id and project.team_id = thread.team_id
    where thread.slack_team_id = ${nonEmpty(address.slackTeamId, "slackTeamId")}
      and thread.channel_id = ${nonEmpty(address.channelId, "channelId")}
      and thread.thread_ts = ${nonEmpty(address.threadTs, "threadTs")}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    threadId: row.id,
    teamId: row.team_id,
    teamSlug: row.team_slug,
    projectId: row.project_id,
    projectSlug: row.project_slug,
    activityId: row.activity_id,
    activityKind: row.kind,
    activityStatus: row.status,
  };
}

/**
 * The thread is this conversation's. A thread already bound keeps its
 * conversation: the Activity's own thread key makes it the same one.
 */
export async function insertSlackThread(
  sql: Queryable,
  input: SlackThreadAddress & { teamId: string; projectId: string; activityId: string },
): Promise<void> {
  await sql`
    insert into public.slack_threads (
      team_id, project_id, activity_id, slack_team_id, channel_id, thread_ts
    ) values (
      ${nonEmpty(input.teamId, "teamId")}::uuid, ${nonEmpty(input.projectId, "projectId")},
      ${nonEmpty(input.activityId, "activityId")}::uuid, ${nonEmpty(input.slackTeamId, "slackTeamId")},
      ${nonEmpty(input.channelId, "channelId")}, ${nonEmpty(input.threadTs, "threadTs")}
    )
    on conflict do nothing
  `;
}

/**
 * Where a conversation's thread is, for its turn to post into, and the Slack
 * user its replies stream to: the one who started the conversation, as they
 * last signed in from the thread's workspace (null once no link is left).
 * Null for a conversation no thread started.
 */
export async function selectSlackThreadOfConversation(
  sql: Queryable,
  input: { teamId: string; activityId: string },
): Promise<(SlackThreadAddress & { threadId: string; teamSlug: string; projectSlug: string; ownerSlackUserId: string | null }) | null> {
  const rows = await sql<Array<{
    id: string; slack_team_id: string; channel_id: string; thread_ts: string; team_slug: string; project_slug: string;
    owner_slack_user_id: string | null;
  }>>`
    select thread.id, thread.slack_team_id, thread.channel_id, thread.thread_ts,
      team.slug as team_slug, project.slug as project_slug,
      ${linkedSlackUser(sql, sql`activity.created_by`, sql`thread.slack_team_id`)} as owner_slack_user_id
    from public.slack_threads thread
    join public.teams team on team.id = thread.team_id
    join public.projects project on project.id = thread.project_id and project.team_id = thread.team_id
    join public.activities activity on activity.id = thread.activity_id
    where thread.activity_id = ${nonEmpty(input.activityId, "activityId")}::uuid
      and thread.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    threadId: row.id,
    slackTeamId: row.slack_team_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    teamSlug: row.team_slug,
    projectSlug: row.project_slug,
    ownerSlackUserId: row.owner_slack_user_id,
  };
}

/** How many of a conversation's newest lines are read beside a message. */
const THREAD_LINES = 8;
/** A line longer than this is read by its beginning, by the gate as by this read. */
const LINE_CHARACTERS = 400;

/** A line as the statement below returns it: ShipBash's reply, or a person's, with the Slack facts it was recorded with. */
interface LineRow {
  reply: boolean;
  author: string;
  slack: unknown;
  text: string;
}

/** A row as the gate reads it, another app's named as one; a line whose facts do not read as Slack's is not one. */
function threadLine(row: LineRow): ThreadLine | null {
  if (row.reply) return { from: "ShipBash", userId: "", shipbash: true, bot: false, text: row.text, mentions: [] };
  const facts = slackLineFacts(row.slack);
  if (!facts) return null;
  const from = facts.bot ? `${row.author} (bot)` : row.author;
  return { from, userId: facts.userId, shipbash: false, bot: facts.bot, text: row.text, mentions: facts.mentions };
}

/**
 * What a new message in a conversation's thread is read beside, in one
 * statement: the conversation's newest lines, oldest first — ShipBash's
 * replies, and what people and other apps said in its thread, members or not,
 * each a line recorded with its Slack facts (a report, ShipBash's note of a
 * Stop or its own alert, a message from the console carries none, and is no
 * line of the thread) — and whether the message's author has addressed
 * ShipBash in this conversation before: had a message of theirs steer it, its
 * opening included.
 */
export async function selectSlackThreadLines(
  sql: Queryable,
  input: { teamId: string; activityId: string; slackUserId: string },
): Promise<{ lines: ThreadLine[]; addressedBefore: boolean }> {
  const activityId = nonEmpty(input.activityId, "activityId");
  const teamId = nonEmpty(input.teamId, "teamId");
  const rows = await sql<Array<{ lines: LineRow[]; addressed_before: boolean }>>`
    select
      coalesce((
        select json_agg(line order by line.sequence) from (
          select sequence, safe_data ->> 'event' = 'agent_output' as reply, safe_data ->> 'author' as author,
            safe_data -> 'slack' as slack, left(coalesce(safe_data ->> 'displayText', body_markdown), ${LINE_CHARACTERS}) as text
          from public.activity_events
          where activity_id = ${activityId}::uuid and team_id = ${teamId}::uuid
            and body_markdown is not null
            and (safe_data ->> 'event' = 'agent_output'
              or (safe_data ->> 'event' = 'steer_requested' and safe_data ? 'slack' and safe_data ? 'author'))
          order by sequence desc
          limit ${THREAD_LINES}
        ) line
      ), '[]'::json) as lines,
      exists (
        select 1 from public.activity_events
        where activity_id = ${activityId}::uuid and team_id = ${teamId}::uuid
          and safe_data ->> 'event' = 'steer_requested' and safe_data ->> 'origin' is null
          and safe_data -> 'slack' ->> 'userId' = ${nonEmpty(input.slackUserId, "slackUserId")}
      ) as addressed_before
  `;
  const row = rows[0];
  return {
    lines: (row?.lines ?? []).map(threadLine).filter((line) => line !== null),
    addressedBefore: row?.addressed_before === true,
  };
}
