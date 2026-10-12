/**
 * Settling the work behind a Runtime Session whose container is gone.
 *
 * Both of an Activity's waiting states strand the same way. `waiting_for_auth`
 * hands the browser to a human mid-run and `waiting_for_input` blocks a
 * Discovery on a question, and in both the Dispatch Job keeps its lease because
 * the container that is waiting is supposed to still be alive to resume itself.
 * When that container dies — a service restart, a `docker rm` — nobody is left
 * holding the lease token, so the capability-scoped settlers cannot reach it and
 * the row waits forever. This module is the honest ending: the waiting-state
 * timeout, expressed as container liveness rather than a wall clock.
 *
 * Scope is deliberately Activities. A Suite Run's waiting_for_auth is a
 * different shape: the worker aborts the run and tears its container down on
 * purpose, then starts a separate viewer container lazily on the first status
 * poll, so "waiting implies a live container" is legitimately false there for as
 * long as the owner takes to click Take control. Sweeping it would kill healthy
 * runs.
 *
 * Narrow in the other direction too: only *waiting* work is swept. A `running`
 * Job whose container died belongs to the expired-lease reclaimers, and
 * terminalizing it here would race them over the same rows.
 */
import type postgres from "postgres";
import type { SelectedRow } from "./table-rows.ts";

/** The states in which a dead container means the Activity can never resume. */
const WAITING_ACTIVITY_STATUSES = ["waiting_for_auth", "waiting_for_input"] as const;

type DeadSessionRow = SelectedRow<
  "runtime_sessions",
  "id" | "team_id" | "project_id" | "source_kind" | "source_id",
  {
  source_kind: "activity" | "suite_run";
  }
>;

export interface TerminalizedRuntimeSession {
  sessionId: string;
  sourceId: string;
}

/**
 * Terminalizes the waiting work behind the given dead sessions and closes their
 * session rows. The caller has already asked Docker which containers are gone;
 * this makes no liveness judgement of its own.
 *
 * Returns only the sessions whose work actually left a waiting state. Sessions
 * whose run had already moved on are still closed — their container really is
 * dead — but are not reported as endings.
 */
export async function terminalizeWaitingWorkForDeadSessions(
  sql: postgres.Sql,
  sessionIds: readonly string[],
  reason: string,
): Promise<TerminalizedRuntimeSession[]> {
  if (sessionIds.length === 0) return [];
  if (sessionIds.length > 500) {
    throw new Error("Dead Runtime Session batch must not exceed 500 sessions.");
  }
  const endReason = reason.trim();
  if (!endReason) throw new Error("reason must not be empty.");
  return await sql.begin(async (transaction) => {
    await transaction.unsafe("set local statement_timeout = '10s'");
    const sessions = await transaction<DeadSessionRow[]>`
      select id, team_id, project_id, source_kind, source_id
      from public.runtime_sessions
      where id = any(${transaction.array([...sessionIds])}::uuid[])
        and ended_at is null
      order by started_at, id
      for update skip locked
    `;
    const ended: TerminalizedRuntimeSession[] = [];
    for (const session of sessions) {
      if (
        session.source_kind === "activity"
        && await terminalizeWaitingActivity(transaction, session, endReason)
      ) {
        ended.push({ sessionId: session.id, sourceId: session.source_id });
      }
      await transaction`
        update public.runtime_sessions
        set phase = 'ended', ended_at = now(), end_reason = ${endReason.slice(0, 500)}
        where id = ${session.id}::uuid and ended_at is null
      `;
    }
    return ended;
  });
}

async function terminalizeWaitingActivity(
  sql: postgres.TransactionSql,
  session: DeadSessionRow,
  reason: string,
): Promise<boolean> {
  // The sequence is claimed in the same statement that terminalizes, so a
  // concurrent event writer cannot take the number this result event needs.
  const waiting = await sql<Array<{ next_event_sequence: string | number }>>`
    update public.activities
    set status = 'needs_attention', completed_at = now(), updated_at = now(),
        next_event_sequence = next_event_sequence + 1
    where id = ${session.source_id}::uuid and team_id = ${session.team_id}::uuid
      and project_id = ${session.project_id}
      and status = any(${sql.array([...WAITING_ACTIVITY_STATUSES])}::text[])
    returning next_event_sequence
  `;
  if (!waiting[0]) return false;
  await sql`
    insert into public.activity_results (
      activity_id, team_id, project_id, kind, summary, recovery_action
    ) values (
      ${session.source_id}::uuid, ${session.team_id}::uuid, ${session.project_id},
      'needs_attention', ${reason.slice(0, 4_000)}, 'Start this Activity again.'
    )
    on conflict (activity_id) do nothing
  `;
  // The terminal event is what the console's open stream and its detail poll are
  // both waiting on; without it the page keeps rendering the waiting pane.
  await sql`
    insert into public.activity_events (
      team_id, project_id, activity_id, sequence, kind, label, safe_data
    ) values (
      ${session.team_id}::uuid, ${session.project_id}, ${session.source_id}::uuid,
      ${Number(waiting[0].next_event_sequence) - 1}, 'result',
      'Activity needs attention',
      ${sql.json({ event: "runtime_session_ended" })}
    )
    on conflict (activity_id, sequence) do nothing
  `;
  // The lease belongs to a process that no longer exists, so the
  // capability-scoped settlers — which require a live lease token — can never
  // reach this Job.
  await sql`
    update public.dispatch_jobs
    set status = 'failed', lease_token = null, lease_owner = null,
        lease_expires_at = null, leased_at = null, heartbeat_at = null,
        failure_reason = ${reason.slice(0, 1_900)}, completed_at = now()
    where team_id = ${session.team_id}::uuid and kind = 'activity'
      and activity_id = ${session.source_id}::uuid
      and status in ('queued', 'leased', 'waiting')
  `;
  return true;
}
