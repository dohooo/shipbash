/**
 * The sweep behind service/sign-in-reaper.ts: rows still saying `verifying`
 * long after any leg could be behind them.
 *
 * One statement settles the row and writes the audit line, so a row can never
 * end up failed with nothing on the trail to say why. `for update skip locked`
 * is what makes it safe to run from every read at once: two readers looking at
 * the same stranded row settle it once between them, and the second sees an
 * empty answer rather than a second event.
 *
 * The consecutive-failure count is deliberately left alone. A leg that never
 * reported proved nothing about the way in, and three host restarts must not
 * add up to the pause that three wrong passwords earn.
 */
import type postgres from "postgres";

type Queryable = postgres.Sql | postgres.TransactionSql;

export interface ReapStrandedSignInsInput {
  /** A row untouched since this moment has no leg left behind it. */
  strandedBefore: Date;
  /** The rows a reader is looking at, or null to sweep every Team's. */
  signInIds?: readonly string[] | null;
  teamId?: string | null;
  limit?: number;
}

/**
 * Settles the stranded rows this call may see, and answers which ones it
 * settled. A row somebody else settled first is simply not in the answer.
 */
export async function reapStrandedSignIns(
  sql: Queryable,
  input: ReapStrandedSignInsInput,
): Promise<string[]> {
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Stranded sign-in limit must be between 1 and 500.");
  }
  const ids = input.signInIds ? [...input.signInIds] : null;
  if (ids?.length === 0) return [];
  const rows = await sql<Array<{ sign_in_id: string }>>`
    with candidate as (
      select id from public.team_sign_ins
      where status = 'verifying'
        and updated_at < ${input.strandedBefore}
        and (${ids === null} or id = any(${sql.array(ids ?? [])}::uuid[]))
        and (${input.teamId ?? null}::uuid is null or team_id = ${input.teamId ?? null}::uuid)
      order by updated_at
      limit ${limit}
      for update skip locked
    ), stranded as (
      update public.team_sign_ins row
      set status = 'failed', failure_reason = 'unknown', updated_at = now()
      from candidate
      where row.id = candidate.id
      returning row.id, row.team_id
    )
    insert into public.team_sign_in_events (team_id, sign_in_id, actor, action, outcome)
    select team_id, id, 'verification_leg', 'verify_failed', 'unknown' from stranded
    returning sign_in_id
  `;
  return rows.map((row) => row.sign_in_id);
}
