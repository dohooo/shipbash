/**
 * The lines Slack delivered in the channels @ShipBash is in, one row per
 * version of a line — as delivered, each edit, its deletion — kept a week
 * from its arrival (slack-chat/thread-lines.ts). A line is one insert; a
 * thread's lines are read once, when a conversation starts in it mid-thread,
 * folded to the newest version of each, the root and the newest up to a
 * cap on lines and on characters; the chat state sweep deletes expired rows
 * (chat-state.ts).
 *
 * Authorization-blind, like their neighbours: the bot answers Slack, whose
 * signature names the workspace.
 */
import type postgres from "postgres";

import { nonEmpty } from "./normalize.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** Where a line is said: its workspace, channel and thread. */
export interface SlackLinePlace {
  slackTeamId: string;
  channelId: string;
  threadTs: string;
}

/** One version of a line under its own ts: what it said as delivered or edited, or its deletion. */
export type SlackLineVersion = { ts: string } & ({ kind: "line" | "edit"; line: object } | { kind: "delete" });

export async function insertSlackThreadLine(sql: Queryable, place: SlackLinePlace, version: SlackLineVersion): Promise<void> {
  await sql`
    insert into public.slack_thread_lines (slack_team_id, channel_id, thread_ts, ts, kind, line)
    values (
      ${nonEmpty(place.slackTeamId, "slackTeamId")}, ${nonEmpty(place.channelId, "channelId")}, ${nonEmpty(place.threadTs, "threadTs")},
      ${nonEmpty(version.ts, "ts")}, ${version.kind}, ${version.kind === "delete" ? null : JSON.stringify(version.line)}::text::jsonb
    )
  `;
}

/** A thread's kept lines before a ts, as many as the caps allow. */
export interface SlackThreadLinesRead {
  /** The root, when kept, then the newest lines up to the caps, oldest first. */
  lines: unknown[];
  /** How many kept lines between the root and those are left out. */
  omitted: number;
  /** The ts of the oldest line kept at all; null when none is. */
  first: string | null;
}

/**
 * A thread's kept lines said before `beforeTs`, each by its newest version
 * and a deleted one not at all: the root, then the newest, at most `lines` of
 * them and, past the first, as long as their words together stay within
 * `characters`. Only those lines leave the database.
 */
export async function selectSlackThreadLinesBefore(
  sql: Queryable,
  place: SlackLinePlace & { beforeTs: string; lines: number; characters: number },
): Promise<SlackThreadLinesRead> {
  const threadTs = nonEmpty(place.threadTs, "threadTs");
  const [read] = await sql<Array<{ lines: unknown[]; omitted: number; first: string | null }>>`
    with newest as (
      select distinct on (ts) ts, kind, line from public.slack_thread_lines
      where slack_team_id = ${nonEmpty(place.slackTeamId, "slackTeamId")}
        and channel_id = ${nonEmpty(place.channelId, "channelId")}
        and thread_ts = ${threadTs}
        and ts::numeric < ${nonEmpty(place.beforeTs, "beforeTs")}::numeric
        and expires_at > now()
      order by ts, id desc
    ), said as (
      -- The root first, then the newest: each line's place, and the characters of its words and every one ahead.
      select ts, line, row_number() over ahead as place, sum(coalesce(length(line ->> 'text'), 0)) over ahead as reach
      from newest
      where kind <> 'delete'
      window ahead as (order by ts = ${threadTs} desc, ts::numeric desc rows unbounded preceding)
    ), cut as (
      select ts, line, place <= ${place.lines} and (place = 1 or reach <= ${place.characters}) as kept from said
    )
    select
      coalesce(jsonb_agg(line order by ts::numeric) filter (where kept), '[]') as lines,
      (count(*) filter (where not kept))::int as omitted,
      (select ts from cut order by ts::numeric limit 1) as first
    from cut
  `;
  return { lines: read?.lines ?? [], omitted: read?.omitted ?? 0, first: read?.first ?? null };
}

/** How many expired lines one sweep deletes; the next sweep takes the rest. */
const SWEEP_LINES = 5_000;

/** Lines past their week, the oldest first, a batch at a time. */
export async function deleteExpiredSlackThreadLines(sql: Queryable): Promise<void> {
  await sql`
    delete from public.slack_thread_lines
    where id in (select id from public.slack_thread_lines where expires_at <= now() order by expires_at limit ${SWEEP_LINES})
  `;
}
