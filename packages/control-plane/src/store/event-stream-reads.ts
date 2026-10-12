/**
 * The narrow reads every repeating reader uses: an SSE tick, a takeover
 * status check, an evidence lookup. Each one returns the rows its caller
 * actually consumes, so an idle tick pulls nothing out of Postgres. Rendering
 * a whole page still goes through getActivityDetail / getSuiteRunDetail.
 */
import type postgres from "postgres";

import { browserStreamUrlFromMetadata } from "@shipbash/contracts/browser-connection-url";
import type { SuiteRunStatus } from "@shipbash/contracts/database-contract-types";
import type { ActivityEvent, ActivityStatus, TenantActor } from "../types.ts";
import type { ActivityEventRow } from "./rows.ts";
import { AGENT_USAGE_EVENT } from "./usage-events.ts";
import { mapActivityEvent } from "./workspace-maps.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** Rows one Activity tick may carry; a longer backlog arrives over the next ticks. */
export const ACTIVITY_TICK_EVENT_LIMIT = 500;

export interface ActivityStreamTick {
  status: ActivityStatus;
  events: ActivityEvent[];
  /** True when the backlog past the cursor outran the page: the lane must not end the stream yet. */
  hasMore: boolean;
}

export interface SuiteRunStreamTick {
  status: SuiteRunStatus;
  /**
   * The greatest sequence of the run's log, 0 when it has none: its usage
   * records are no line of it (run-log.ts), so a stream that read every line
   * catches up with the tick and can end.
   */
  lastSequence: number;
  /** The address the latest browser_stream_ready event names, or null. */
  streamUrl: string | null;
}

/** Where one piece of Activity evidence is stored, as the event trail recorded it. */
export interface ActivityEvidence {
  objectPath: string;
  mimeType: string | null;
}

type SuiteRunTickRow = {
  status: SuiteRunStatus;
  last_sequence: number | string;
  stream_data: Record<string, unknown> | null;
};

export async function readActivityStatus(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedActivityId: string,
): Promise<ActivityStatus | null> {
  const rows = await sql<Array<{ status: ActivityStatus }>>`
    select activity.status
    from public.team_memberships membership
    join public.activities activity on activity.team_id = membership.team_id
    where membership.team_id = ${scopedTeamId}::uuid
      and membership.user_id = ${actor.userId}::uuid
      and activity.project_id = ${scopedProjectId}
      and activity.id = ${scopedActivityId}::uuid
    limit 1
  `;
  return rows[0]?.status ?? null;
}

export async function readSuiteRunStatus(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedRunId: string,
): Promise<SuiteRunStatus | null> {
  const rows = await sql<Array<{ status: SuiteRunStatus }>>`
    select run.status
    from public.team_memberships membership
    join public.suite_runs run on run.team_id = membership.team_id
    where membership.team_id = ${scopedTeamId}::uuid
      and membership.user_id = ${actor.userId}::uuid
      and run.project_id = ${scopedProjectId}
      and run.id = ${scopedRunId}
    limit 1
  `;
  return rows[0]?.status ?? null;
}

export async function readActivityStreamTick(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedActivityId: string,
  afterSequence: number,
): Promise<ActivityStreamTick | null> {
  const status = await readActivityStatus(sql, actor, scopedTeamId, scopedProjectId, scopedActivityId);
  if (!status) return null;
  // activity_events_team_project_idx covers this predicate and its order.
  const rows = await sql<ActivityEventRow[]>`
    select id, team_id, project_id, activity_id, sequence, kind,
      label, body_markdown, safe_data, created_at
    from public.activity_events
    where team_id = ${scopedTeamId}::uuid
      and project_id = ${scopedProjectId}
      and activity_id = ${scopedActivityId}::uuid
      and sequence > ${afterSequence}
    order by sequence, id
    limit ${ACTIVITY_TICK_EVENT_LIMIT + 1}
  `;
  return {
    status,
    events: rows.slice(0, ACTIVITY_TICK_EVENT_LIMIT).map((row) => mapActivityEvent(row)),
    hasMore: rows.length > ACTIVITY_TICK_EVENT_LIMIT,
  };
}

export async function readSuiteRunStreamTick(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedRunId: string,
): Promise<SuiteRunStreamTick | null> {
  const rows = await sql<SuiteRunTickRow[]>`
    select run.status,
      coalesce((
        select max(event.sequence) from public.run_events event
        where event.team_id = run.team_id and event.project_id = run.project_id
          and event.suite_run_id = run.id and event.type <> ${AGENT_USAGE_EVENT}
      ), 0) as last_sequence,
      stream.data as stream_data
    from public.team_memberships membership
    join public.suite_runs run on run.team_id = membership.team_id
    left join lateral (
      select event.data from public.run_events event
      where event.team_id = run.team_id and event.project_id = run.project_id
        and event.suite_run_id = run.id and event.type = 'browser_stream_ready'
      order by event.sequence desc limit 1
    ) stream on true
    where membership.team_id = ${scopedTeamId}::uuid
      and membership.user_id = ${actor.userId}::uuid
      and run.project_id = ${scopedProjectId}
      and run.id = ${scopedRunId}
    limit 1
  `;
  const row = rows[0];
  return row ? {
    status: row.status,
    lastSequence: Number(row.last_sequence),
    streamUrl: browserStreamUrlFromMetadata(row.stream_data),
  } : null;
}

/**
 * The latest event carrying this piece of evidence. The membership read above
 * it is the explicit authorization; a null sessionId matches every session.
 */
export async function readActivityEvidence(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedActivityId: string,
  match: { event: string; sessionId: string | null },
): Promise<ActivityEvidence | null> {
  const status = await readActivityStatus(sql, actor, scopedTeamId, scopedProjectId, scopedActivityId);
  if (!status) return null;
  const rows = await sql<Array<{ object_path: string; mime_type: string | null }>>`
    select safe_data ->> 'artifactObjectPath' as object_path,
      safe_data ->> 'mimeType' as mime_type
    from public.activity_events
    where team_id = ${scopedTeamId}::uuid
      and project_id = ${scopedProjectId}
      and activity_id = ${scopedActivityId}::uuid
      and safe_data ->> 'event' = ${match.event}
      and (${match.sessionId}::text is null or safe_data ->> 'sessionId' = ${match.sessionId})
      and jsonb_typeof(safe_data -> 'artifactObjectPath') = 'string'
    order by sequence desc
    limit 1
  `;
  const row = rows[0];
  return row ? { objectPath: row.object_path, mimeType: row.mime_type } : null;
}
