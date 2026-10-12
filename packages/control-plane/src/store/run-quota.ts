/**
 * A team's monthly allowance of verification Runs, held only on a
 * deployment that turns it on (`runQuota`, configuration.ts). Then a team
 * whose runs that ended since the start of this UTC calendar month count as
 * many Runs as its quota (teams.monthly_run_quota; null is no limit) starts no
 * new verification run, however it is asked for. Off, no team has a quota and
 * nothing is refused; Runs are recorded either way. A run under way counts
 * once it ends (run-units.ts). Discovery, conversations and maintenance are
 * neither counted nor refused.
 */
import type postgres from "postgres";

import type { Queryable } from "./actor-spine.ts";

/** The Runs a team has used this month, and its quota (null is no limit). */
export interface RunAllowance {
  used: number;
  quota: number | null;
}

/** Work that spends Runs — a verification run, a walk — refused because the team has used this month's. */
export class RunQuotaExceededError extends Error {
  readonly code = "RUN_QUOTA_EXCEEDED";

  constructor(
    readonly used: number,
    readonly quota: number,
  ) {
    super(`This team has used ${String(used)} of its ${String(quota)} beta Runs for this month.`);
    this.name = "RunQuotaExceededError";
  }
}

/** The start of this UTC calendar month, where every monthly sum begins. */
export function monthStart(sql: Queryable): postgres.Fragment {
  return sql`date_trunc('month', now(), 'UTC')`;
}

/**
 * The Runs this month of the team joined as `team`: the run_units of its runs
 * that ended since `since` (monthStart). The one definition of a team's Runs
 * this month, a range over suite_runs_team_completed_idx.
 */
export function runsUsedSince(sql: Queryable, since: postgres.Fragment): postgres.Fragment {
  return sql`(
    select coalesce(sum(run.run_units), 0)::integer
    from public.suite_runs run
    where run.team_id = team.id and run.completed_at >= ${since}
  )`;
}

/** The team's allowance in one indexed query, with no quota when `runQuota` is off; null for a team `sql` cannot see. */
export async function readRunAllowance(sql: Queryable, teamId: string, runQuota: boolean): Promise<RunAllowance | null> {
  const rows = await sql<RunAllowance[]>`
    select team.monthly_run_quota as quota, ${runsUsedSince(sql, monthStart(sql))} as used
    from public.teams team
    where team.id = ${teamId}::uuid
  `;
  const team = rows[0];
  if (!team) return null;
  return runQuota ? team : { ...team, quota: null };
}

/** A team's Runs on one UTC day in one project. */
export interface RunDay {
  day: string;
  projectId: string;
  runs: number;
}

/**
 * The team's Runs per UTC day and project, counted like the allowance (by the
 * day a run ended), from the Sunday of the week 364 days ago through today:
 * the year of weeks the Usage pane draws. Days without a Run are left out.
 * `sql` must be scoped to a reader of the team.
 */
export async function readRunDays(sql: Queryable, teamId: string): Promise<RunDay[]> {
  return sql<RunDay[]>`
    with first_day as (select (now() at time zone 'UTC')::date - 364 as day)
    select to_char((run.completed_at at time zone 'UTC')::date, 'YYYY-MM-DD') as day,
      run.project_id::text as "projectId", sum(run.run_units)::integer as runs
    from public.suite_runs run, first_day
    where run.team_id = ${teamId}::uuid
      and run.completed_at >= ((first_day.day - extract(dow from first_day.day)::integer)::timestamp at time zone 'UTC')
      and run.run_units > 0
    group by 1, 2
    order by 1, 2
  `;
}

/** Why the team may start no more work that spends Runs this month; null while Runs remain or `runQuota` is off. */
export async function runQuotaExceeded(
  sql: postgres.TransactionSql,
  teamId: string,
  runQuota: boolean,
): Promise<RunQuotaExceededError | null> {
  if (!runQuota) return null;
  const team = await readRunAllowance(sql, teamId, runQuota);
  if (!team) throw new Error("Team not found.");
  return team.quota !== null && team.used >= team.quota ? new RunQuotaExceededError(team.used, team.quota) : null;
}

/** Throws RunQuotaExceededError when the team may start no more work that spends Runs this month. */
export async function assertRunQuotaAvailable(sql: postgres.TransactionSql, teamId: string, runQuota: boolean): Promise<void> {
  const exceeded = await runQuotaExceeded(sql, teamId, runQuota);
  if (exceeded) throw exceeded;
}
