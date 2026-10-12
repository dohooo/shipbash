/**
 * A conversation thread's to-do lists as the store keeps them: each piece of
 * work the thread started rides in the list under the reply that announced
 * it (slack_thread_work.reply_ts), and that reply is kept with its blocks as
 * ShipBash last set them (slack_thread_replies), so a draw sends them back
 * with the list swapped and never reads the message back from Slack.
 *
 * A reply announces the work no reply has carried yet that is still in
 * flight: the turn reads those rows, posts its reply with their list, and
 * then records the reply and gives it those rows — only the rows it read,
 * and only while no reply holds them — so a row is announced once. Work that
 * ended before any reply carried it rides in no list: its end reaches the
 * conversation as a report. Whoever draws reads the reply's blocks and the
 * work in its list as it stands — a walk at work with the step it is on —
 * and keeps nothing of the draw. Work its owner stopped
 * (slack-thread-stops.ts) keeps its line, drawn as stopped and by whom — the
 * Slack user the stopper signed in as in that workspace — and, being in
 * flight nowhere, is never announced.
 *
 * Authorization-blind, like their neighbours: the turn, the bot and the
 * worker are trusted by construction, and every statement is bound to the
 * thread it names.
 */
import type postgres from "postgres";

import type { SuiteRunStatus } from "@shipbash/contracts/database-contract-types";
import type { WorkRef } from "../dispatch-worker-types.ts";
import type { ActivitySummary } from "../types.ts";
import { jsonValue, nonEmpty } from "./normalize.ts";
import { type RunJourney, inFlight, selectRunJourneys, walkBeat, walkHeldBy } from "./slack-thread-work.ts";
import type { SlackThreadAddress } from "./slack-threads.ts";
import { linkedSlackUser } from "./slack-user-links.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/**
 * One line's work, as it stands: a run is a line per Journey, a walk one
 * line. `workId` is its row, which its Stop names; `inFlight`, whether it is
 * still under way (slack-thread-work.ts `inFlight`), so it can be stopped;
 * `stopped`, when its owner stopped it, by which Slack user, when the
 * stopper signed in from the thread's workspace.
 */
export type ThreadListItem = { workId: string; inFlight: boolean; stopped: { by: string | null } | null } & (
  | { kind: "run"; suiteRunId: string; status: SuiteRunStatus; journeys: RunJourney[] }
  | {
    kind: "walk";
    activityId: string;
    title: string | null;
    status: ActivitySummary["status"];
    /** While queued: the kind of the Activity holding the project's Sandbox slot. */
    heldBy: string | null;
    /** While it runs: its latest words to the owner, the step it is on. */
    beat: string | null;
  }
);

/** The thread a list is drawn in, and what its links are built from. */
export interface ThreadListPlace extends SlackThreadAddress {
  threadId: string;
  teamId: string;
  conversationId: string;
  teamSlug: string;
  projectSlug: string;
}

/** Where a piece of work's list is: its thread, and the reply carrying the list; `replyTs` is null until a reply did. */
export interface ThreadWorkPlace {
  thread: ThreadListPlace;
  replyTs: string | null;
}

/** A reply's list as it stands: the reply's blocks as ShipBash last set them, and every line's work. */
export interface ThreadList {
  blocks: unknown[];
  items: ThreadListItem[];
}

/** The thread's work in flight that no reply has carried yet: the rows a reply announces, and their lines. */
export interface UnannouncedWork {
  workIds: string[];
  items: ThreadListItem[];
}

async function selectItems(
  sql: Queryable,
  input: { teamId: string; threadId: string; replyTs: string | null },
): Promise<{ workIds: string[]; items: ThreadListItem[] }> {
  const which = input.replyTs === null ? sql`work.reply_ts is null and ${inFlight(sql)}` : sql`work.reply_ts = ${input.replyTs}`;
  const rows = await sql<Array<{
    id: string; suite_run_id: string | null; run_status: SuiteRunStatus | null; walk_id: string | null; title: string | null;
    walk_status: ActivitySummary["status"] | null; held_by: string | null; beat: string | null; in_flight: boolean;
    stopped: boolean; stopped_by: string | null;
  }>>`
    select work.id::text as id, ${inFlight(sql)} as in_flight, work.stopped_at is not null as stopped,
      case when work.stopped_by is not null then ${linkedSlackUser(sql, sql`work.stopped_by`, sql`thread.slack_team_id`)} end as stopped_by,
      work.suite_run_id, run.status as run_status,
      walk.id::text as walk_id, work.title, walk.status as walk_status,
      case when walk.status = 'queued' then ${walkHeldBy(sql)} end as held_by,
      case when walk.status = 'running' then ${walkBeat(sql)} end as beat
    from public.slack_thread_work work
    join public.slack_threads thread on thread.id = work.slack_thread_id
    left join public.suite_runs run on run.id = work.suite_run_id
    left join public.activities walk on walk.id = work.walk_activity_id
    where work.slack_thread_id = ${nonEmpty(input.threadId, "threadId")}::uuid and ${which}
    order by work.created_at, work.id
  `;
  const items = await Promise.all(rows.map(async (row): Promise<ThreadListItem | null> => {
    const work = { workId: row.id, inFlight: row.in_flight, stopped: row.stopped ? { by: row.stopped_by } : null };
    if (row.suite_run_id && row.run_status) {
      const journeys = await selectRunJourneys(sql, { teamId: input.teamId, suiteRunId: row.suite_run_id });
      return { ...work, kind: "run", suiteRunId: row.suite_run_id, status: row.run_status, journeys };
    }
    if (!row.walk_id || !row.walk_status) return null;
    return { ...work, kind: "walk", activityId: row.walk_id, title: row.title, status: row.walk_status, heldBy: row.held_by, beat: row.beat };
  }));
  return { workIds: rows.map((row) => row.id), items: items.filter((item) => item !== null) };
}

/** Where the work's list is; null for work no thread started. */
export async function selectThreadWorkPlace(sql: Queryable, work: WorkRef): Promise<ThreadWorkPlace | null> {
  const which = "suiteRunId" in work
    ? sql`work.suite_run_id = ${nonEmpty(work.suiteRunId, "suiteRunId")}`
    : sql`work.walk_activity_id = ${nonEmpty(work.activityId, "activityId")}::uuid`;
  const rows = await sql<Array<{
    thread_id: string; team_id: string; conversation_id: string; slack_team_id: string; channel_id: string; thread_ts: string;
    team_slug: string; project_slug: string; reply_ts: string | null;
  }>>`
    select thread.id::text as thread_id, thread.team_id, thread.activity_id::text as conversation_id,
      thread.slack_team_id, thread.channel_id, thread.thread_ts,
      team.slug as team_slug, project.slug as project_slug, work.reply_ts
    from public.slack_thread_work work
    join public.slack_threads thread on thread.id = work.slack_thread_id
    join public.teams team on team.id = thread.team_id
    join public.projects project on project.id = thread.project_id and project.team_id = thread.team_id
    where ${which}
  `;
  const row = rows[0];
  if (!row) return null;
  const thread: ThreadListPlace = {
    threadId: row.thread_id, teamId: row.team_id, conversationId: row.conversation_id,
    slackTeamId: row.slack_team_id, channelId: row.channel_id, threadTs: row.thread_ts,
    teamSlug: row.team_slug, projectSlug: row.project_slug,
  };
  return { thread, replyTs: row.reply_ts };
}

/** The list under the reply, as its work stands; null for a reply that carries none. */
export async function selectThreadList(
  sql: Queryable,
  input: { teamId: string; threadId: string; replyTs: string },
): Promise<ThreadList | null> {
  const [reply] = await sql<Array<{ blocks: unknown }>>`
    select blocks from public.slack_thread_replies
    where slack_thread_id = ${nonEmpty(input.threadId, "threadId")}::uuid and reply_ts = ${nonEmpty(input.replyTs, "replyTs")}
  `;
  if (!reply) return null;
  const { items } = await selectItems(sql, input);
  return { blocks: Array.isArray(reply.blocks) ? reply.blocks : [], items };
}

/** The thread's work in flight that no reply has carried yet, oldest first. */
export async function selectUnannouncedThreadWork(
  sql: Queryable,
  input: { teamId: string; threadId: string },
): Promise<UnannouncedWork> {
  return selectItems(sql, { ...input, replyTs: null });
}

/**
 * The reply that carried these rows' list is recorded with the blocks it was
 * posted with, and holds the rows from now on; a row another reply took first
 * stays with it.
 */
export async function announceThreadWork(
  sql: postgres.Sql,
  input: { threadId: string; workIds: readonly string[]; replyTs: string; blocks: readonly unknown[] },
): Promise<void> {
  const threadId = nonEmpty(input.threadId, "threadId");
  const replyTs = nonEmpty(input.replyTs, "replyTs");
  await sql.begin(async (tx) => {
    await tx`
      insert into public.slack_thread_replies (slack_thread_id, reply_ts, blocks)
      values (${threadId}::uuid, ${replyTs}, ${tx.json(jsonValue(input.blocks))})
    `;
    await tx`
      update public.slack_thread_work set reply_ts = ${replyTs}
      where slack_thread_id = ${threadId}::uuid and id = any(${tx.array([...input.workIds])}::uuid[]) and reply_ts is null
    `;
  });
}
