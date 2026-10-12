/**
 * The record an Activity's read tools answer from, beside the reads every
 * job shares (history-for-job.ts): the Project's live Journeys, whose earlier
 * walks a Discovery or maintenance leg reads, and its earlier Discovery and
 * maintenance sessions with what they proposed and what the owner kept, as
 * they stood when the leg was claimed.
 */
import type postgres from "postgres";

import type { HistoryJourney, HistoryScope } from "./history-for-job.ts";
import type { Timestamp } from "./rows.ts";

export const HISTORY_SESSIONS = 5;
/** The newest written events of a session: its narrative, the owner's words and the result. */
const SESSION_EVENTS = 20;

export interface HistorySession {
  id: string;
  kind: string;
  status: string;
  created_at: Timestamp;
  completed_at: Timestamp | null;
  summary: string | null;
  proposed: number;
  accepted: number;
}

export interface HistorySessionEvent {
  label: string;
  body_markdown: string;
}

/** Every Journey of the Project live at `asOf`, each standing for itself. */
export async function projectJourneys(sql: postgres.Sql, scope: HistoryScope): Promise<HistoryJourney[]> {
  const journeys = await sql<Array<{ id: string; title: string; role: string; revision: number }>>`
    select id, title, role, revision
    from public.suite_cases
    where team_id = ${scope.teamId}::uuid and project_id = ${scope.projectId}
      and created_at <= ${scope.asOf} and (archived_at is null or archived_at > ${scope.asOf})
    order by suite_id, position
  `;
  return journeys.map((journey) => ({ key: journey.id, title: journey.title, role: journey.role, revision: journey.revision, caseIds: [journey.id] }));
}

/** The Project's newest sessions finished by `asOf`, leaving out the scope's own Activity. */
export async function earlierSessions(
  sql: postgres.Sql,
  scope: HistoryScope & { activityId: string },
  limit = HISTORY_SESSIONS,
): Promise<HistorySession[]> {
  return sql<HistorySession[]>`
    select activity.id, activity.kind, activity.status, activity.created_at, activity.completed_at, result.summary,
      coalesce(sum(jsonb_array_length(proposal.candidate_definition)), 0)::integer as proposed,
      coalesce(sum(jsonb_array_length(proposal.candidate_definition)) filter (where proposal.status = 'accepted'), 0)::integer as accepted
    from public.activities activity
    left join public.activity_results result on result.activity_id = activity.id
    left join public.proposals proposal
      on proposal.team_id = activity.team_id and proposal.trigger ->> 'activityId' = activity.id::text
    where activity.team_id = ${scope.teamId}::uuid and activity.project_id = ${scope.projectId}
      and activity.id <> ${scope.activityId}::uuid and activity.completed_at <= ${scope.asOf}
      -- A chat's many short turns, and the walks it starts, would crowd the
      -- Discovery and edit walks out of this small window; what a chat's walk
      -- drafted reaches the record through the Suite once its drafts are kept,
      -- and the chat reads each walk through its report.
      and activity.kind not in ('conversation', 'walk')
    group by activity.id, result.summary
    order by activity.created_at desc
    limit ${limit}
  `;
}

/** One session's newest written events, oldest first. */
export async function sessionEvents(sql: postgres.Sql, teamId: string, activityId: string): Promise<HistorySessionEvent[]> {
  return sql<HistorySessionEvent[]>`
    select label, body_markdown
    from (
      select label, body_markdown, sequence
      from public.activity_events
      where team_id = ${teamId}::uuid and activity_id = ${activityId}::uuid and body_markdown is not null
      order by sequence desc
      limit ${SESSION_EVENTS}
    ) recent
    order by sequence
  `;
}
