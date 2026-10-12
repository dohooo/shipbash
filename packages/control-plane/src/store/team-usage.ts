/**
 * Every team's usage this UTC calendar month, for the internal lane: the Runs
 * its verification runs counted (run-quota.ts), its quota, and the usage
 * facts priced by usage-cost.ts — the token counters of every
 * agent_usage record and every jev_decision on its runs and Activities, and
 * the time its runs and Sandbox Activities held a Sandbox. Each per-team sum
 * is a range over a (team_id, time) index from the start of the month.
 */
import { HOST_KINDS } from "@shipbash/contracts/runtime/discovery-surface.mjs";
import type postgres from "postgres";

import type { UsageFacts } from "../usage-cost.ts";
import { monthStart, runsUsedSince } from "./run-quota.ts";

export interface TeamUsage {
  teamId: string;
  name: string;
  slug: string;
  monthlyRunQuota: number | null;
  runsThisMonth: number;
  usage: UsageFacts;
}

type TeamUsageRow = Omit<TeamUsage, "usage"> & UsageFacts;

/**
 * Sums are float8 so a large month still arrives as a number. Sandbox time is
 * each run's and Activity's started_at to completed_at once it has ended; a
 * woken Activity clears both, so only its last leg is there to count.
 */
export async function listTeamUsage(sql: postgres.Sql): Promise<TeamUsage[]> {
  const rows = await sql<TeamUsageRow[]>`
    with month as (select ${monthStart(sql)} as start)
    select team.id as "teamId", team.name, team.slug, team.monthly_run_quota as "monthlyRunQuota",
      ${runsUsedSince(sql, sql`month.start`)} as "runsThisMonth", sandbox.seconds as "sandboxSeconds",
      events.input as "inputTokens", events.cache_write as "cacheWriteTokens",
      events.cache_read as "cacheReadTokens", events.output as "outputTokens", events.jev as "jevRequests"
    from public.teams team
    cross join month
    cross join lateral (
      select coalesce(sum(extract(epoch from work.completed_at - work.started_at)), 0)::float8 as seconds
      from (
        select run.started_at, run.completed_at from public.suite_runs run
        where run.team_id = team.id and run.completed_at >= month.start
        union all
        select activity.started_at, activity.completed_at from public.activities activity
        where activity.team_id = team.id and activity.completed_at >= month.start
          and activity.kind <> all(${[...HOST_KINDS]}::text[])
      ) work
    ) sandbox
    cross join lateral (
      select
        coalesce(sum((event.data ->> 'input')::float8) filter (where event.kind = 'agent_usage'), 0) as input,
        coalesce(sum((event.data ->> 'cacheWrite')::float8) filter (where event.kind = 'agent_usage'), 0) as cache_write,
        coalesce(sum((event.data ->> 'cacheRead')::float8) filter (where event.kind = 'agent_usage'), 0) as cache_read,
        coalesce(sum((event.data ->> 'output')::float8) filter (where event.kind = 'agent_usage'), 0) as output,
        (count(*) filter (where event.kind = 'jev_decision'))::integer as jev
      from (
        select run_event.type as kind, run_event.data from public.run_events run_event
        where run_event.team_id = team.id and run_event.type in ('agent_usage', 'jev_decision')
          and run_event.created_at >= month.start
        union all
        select activity_event.safe_data ->> 'event', activity_event.safe_data from public.activity_events activity_event
        where activity_event.team_id = team.id and activity_event.safe_data ->> 'event' in ('agent_usage', 'jev_decision')
          and activity_event.created_at >= month.start
      ) event
    ) events
    order by team.name, team.slug
  `;
  return rows.map(({ teamId, name, slug, monthlyRunQuota, runsThisMonth, ...usage }) => ({
    teamId, name, slug, monthlyRunQuota, runsThisMonth, usage,
  }));
}

/** Sets the team's monthly Run quota (null is no limit); false when there is no such team. */
export async function setTeamRunQuota(sql: postgres.Sql, teamId: string, quota: number | null): Promise<boolean> {
  const rows = await sql`
    update public.teams set monthly_run_quota = ${quota}, updated_at = now()
    where id = ${teamId}::uuid
    returning id
  `;
  return rows.length > 0;
}
