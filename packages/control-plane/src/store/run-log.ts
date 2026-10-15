/**
 * A run's log, read from a point on: the events one member of a run's family
 * wrote after a sequence, for a reader that holds the log up to there. The
 * run's page and its event stream read each event as its log line does — a
 * few keys of its data, and the stored file an artifact_saved names. A run's
 * detail (run-detail.ts) names the member whose log its page shows,
 * `activeRun`.
 */
import type postgres from "postgres";

import type { RunnerArtifact, RunnerRunEvent } from "../types.ts";
import { iso } from "./normalize.ts";
import { readFamilyRuns } from "./run-family.ts";
import { SUITE_RUN_ROW_COLUMNS, type SuiteRunRow, type Timestamp } from "./rows.ts";
import type { SelectedRow } from "./table-rows.ts";
import { UNLISTED_RUN_EVENTS } from "./unlisted-run-events.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/**
 * The keys of an event's data the run's page reads: its log line (runEventView:
 * detail, tool, artifactId) and the agent's pointer (agentPointerFromEventData).
 */
const PAGE_EVENT_DATA_KEYS = ["detail", "tool", "artifactId", "x", "y", "width", "height", "action"] as const;

export type PageEventData = Partial<Record<(typeof PAGE_EVENT_DATA_KEYS)[number], unknown>>;

/** An event as the run's page reads it: without its run and Case Run, and with only the keys of its data the page reads. */
export type RunLogEvent = Omit<RunnerRunEvent, "suiteRunId" | "caseRunId" | "data"> & { data: PageEventData | null };

/** Where a reader's log goes on from: the last event read, or `after` again when none came. */
interface LogPage<Event> {
  events: Event[];
  nextAfter: number;
}

/** The page's log from a point on, with the stored files its lines attach. */
export interface RunLog extends LogPage<RunLogEvent> {
  artifacts: Array<Pick<RunnerArtifact, "id" | "kind" | "label">>;
}

type PageEventRow = SelectedRow<
  "run_events",
  "id" | "sequence" | "type" | "level" | "message" | "created_at",
  {
    sequence: number | string;
    level: RunnerRunEvent["level"];
    data: PageEventData | null;
    created_at: Timestamp;
    artifact: RunLog["artifacts"][number] | null;
  }
>;

/** A run's log from a point on: the run, and the last event of it a reader holds. */
interface LogCursor {
  teamId: string;
  projectId: string;
  logRunId: string;
  after: number;
}

interface LogScope extends LogCursor {
  /** The run whose page asks: the log is one member of its family. */
  pageRunId: string;
}

/** Whether the log the page names is one of the page run's family. */
async function familyOfLog(sql: Queryable, scope: LogScope): Promise<boolean> {
  const [pageRun] = await sql<SuiteRunRow[]>`
    select ${sql(SUITE_RUN_ROW_COLUMNS)}
    from public.suite_runs
    where team_id = ${scope.teamId}::uuid and project_id = ${scope.projectId} and id = ${scope.pageRunId}
    limit 1
  `;
  if (!pageRun) return false;
  const members = await readFamilyRuns(sql, scope.teamId, pageRun);
  return members.some((member) => member.id === scope.logRunId);
}

/**
 * The log's events after the cursor. The run's accounting (unlisted-run-events.ts)
 * is never a line of its log.
 */
function eventsAfter(sql: Queryable, scope: LogCursor) {
  return sql`
    event.team_id = ${scope.teamId}::uuid and event.project_id = ${scope.projectId}
      and event.suite_run_id = ${scope.logRunId} and event.sequence > ${scope.after}
      and event.type <> all(${[...UNLISTED_RUN_EVENTS]}::text[])
  `;
}

function logPage<Event extends { sequence: number }>(events: Event[], after: number): LogPage<Event> {
  return { events, nextAfter: events.at(-1)?.sequence ?? after };
}

/**
 * The lines of a run's log after the cursor, at most `limit` of them when the
 * reader pages (the event stream's ticks). An artifact_saved line attaches the
 * file it names once that file is stored, a file of the walk that saved it.
 * Authorization-blind: the actor lane runs it under RLS, and the statement is
 * bound to the team.
 */
export async function readLogLines(sql: Queryable, cursor: LogCursor, limit: number | null): Promise<RunLog> {
  const rows = await sql<PageEventRow[]>`
    select event.id, event.sequence, event.type, event.level, event.message,
      case when jsonb_typeof(event.data) = 'object' then (
        select jsonb_object_agg(field.key, field.value)
        from jsonb_each(event.data) field
        where field.key = any(${sql.array([...PAGE_EVENT_DATA_KEYS])}::text[])
      ) end as data,
      event.created_at,
      case when artifact.id is null then null
        else json_build_object('id', artifact.id, 'kind', artifact.kind, 'label', artifact.label)
      end as artifact
    from public.run_events event
    left join public.artifacts artifact
      on event.type = 'artifact_saved'
     and artifact.id = event.data ->> 'artifactId'
     and artifact.case_run_id = event.case_run_id
     and artifact.team_id = ${cursor.teamId}::uuid
     and artifact.project_id = ${cursor.projectId}
     and artifact.storage_status = 'available'
    where ${eventsAfter(sql, cursor)}
    order by event.sequence
    ${limit === null ? sql`` : sql`limit ${limit}`}
  `;
  const events = rows.map((row): RunLogEvent => ({
    id: row.id,
    sequence: Number(row.sequence),
    type: row.type,
    level: row.level,
    message: row.message,
    data: row.data,
    createdAt: iso(row.created_at, "run_events.created_at"),
  }));
  return { ...logPage(events, cursor.after), artifacts: rows.flatMap((row) => row.artifact ? [row.artifact] : []) };
}

/** The page's log of a member of the page run's family; null outside the family. */
export async function readRunLog(sql: Queryable, scope: LogScope): Promise<RunLog | null> {
  return await familyOfLog(sql, scope) ? readLogLines(sql, scope, null) : null;
}
