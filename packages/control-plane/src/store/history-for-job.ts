/**
 * The record an agent's read tools answer from (agent-data/), under one
 * job's scope: the job's own team, Project, Activity or Suite Run and the
 * moment it was claimed, read once from the job row under its lease, never
 * from the caller. Every read after it filters by that scope and reads the
 * record as it stood then, so what a tool lists stays what the leg started
 * with however long it runs, and a walk's id means the same walk on every
 * call. This module holds the reads both kinds share; the Activity's own —
 * the Project's Journeys, its earlier sessions — are history-for-project.ts.
 */
import type postgres from "postgres";

import type { DispatchJobLeaseCapability } from "../types.ts";
import { projectJourneys } from "./history-for-project.ts";
import { nonEmpty, sha256 } from "./normalize.ts";
import type { Timestamp } from "./rows.ts";

/** Earlier walks listed per Journey, and the earlier runs a list pages through and a read finds one in. */
export const HISTORY_WALKS_PER_JOURNEY = 10;
export const HISTORY_RUNS = 100;

/** What every read is scoped by: the job's team, Project, Activity or Suite Run, and when it was claimed. */
export interface HistoryScope {
  teamId: string;
  projectId: string;
  activityId: string | null;
  suiteRunId: string | null;
  /** The record as it stood when the job was claimed: nothing finished later is read. */
  asOf: Date;
}

/** A Journey or hook the walks are filed under: its Suite Case, and the Cases that stand for it in this scope. */
export interface HistoryJourney {
  key: string;
  title: string;
  role: string;
  revision: number | null;
  caseIds: string[];
}

export interface HistoryCaseRun {
  id: string;
  suite_run_id: string;
  attempt: number;
  verdict: string | null;
  summary: string | null;
  failure_reason: string | null;
  checklist: unknown;
  role: string;
  completed_at: Timestamp;
  suite_case_id: string;
  suite_case_revision: number | null;
  title: string;
  source_suite_run_id: string | null;
  trigger_kind: string | null;
}

export interface HistoryRun {
  id: string;
  source_suite_run_id: string | null;
  trigger_kind: string | null;
  verdict: string | null;
  created_at: Timestamp;
  completed_at: Timestamp | null;
}

export type HistoryRunCase = Pick<HistoryCaseRun, "id" | "suite_run_id" | "verdict" | "summary" | "failure_reason" | "role" | "title">;

/** A step record (walk.json) registered for a walk: its id names the walk it records, kept or not. */
export interface HistoryWalkArtifact {
  id: string;
  case_run_id: string;
  object_path: string;
  storage_status: string;
}

interface ScopeRow {
  team_id: string;
  project_id: string;
  activity_id: string | null;
  suite_run_id: string | null;
  leased_at: Timestamp;
}

/**
 * The job's scope, under its live lease — owner included — with no lock and
 * no transaction: the reads after it hold no connection across a Storage
 * download. A lease that lapsed refuses in the store's own words.
 */
export async function agentDataScope(sql: postgres.Sql, capability: DispatchJobLeaseCapability): Promise<HistoryScope> {
  const rows = await sql<ScopeRow[]>`
    select job.team_id, job.project_id, job.activity_id, job.suite_run_id, job.leased_at
    from public.dispatch_jobs job
    where job.id = ${nonEmpty(capability.jobId, "capability.jobId")}::uuid
      and job.identity_hash = ${sha256(capability.identityHash, "capability.identityHash")}
      and job.status = 'leased'
      and job.lease_owner = ${nonEmpty(capability.workerId, "capability.workerId")}
      and job.lease_token = ${nonEmpty(capability.leaseToken, "capability.leaseToken")}::uuid
      and job.lease_expires_at > clock_timestamp() and job.expires_at > clock_timestamp()
  `;
  const row = rows[0];
  if (!row) throw new Error("Dispatch Job lease is invalid, expired, or already released.");
  return {
    teamId: row.team_id,
    projectId: row.project_id,
    activityId: row.activity_id,
    suiteRunId: row.suite_run_id,
    asOf: new Date(row.leased_at),
  };
}

/** The Suite Run's own Cases, each filed under the Journey (Suite Case) it is a snapshot of. */
async function suiteRunJourneys(sql: postgres.Sql, scope: HistoryScope & { suiteRunId: string }): Promise<HistoryJourney[]> {
  const cases = await sql<Array<{ snapshot_case_id: string; suite_case_id: string | null; title: string; role: string; suite_case_revision: number | null }>>`
    select snapshot_case.id as snapshot_case_id, snapshot_case.suite_case_id, snapshot_case.title,
      snapshot_case.role, snapshot_case.suite_case_revision
    from public.suite_runs suite_run
    join public.suite_snapshot_cases snapshot_case on snapshot_case.snapshot_id = suite_run.suite_snapshot_id
    where suite_run.id = ${scope.suiteRunId} and suite_run.team_id = ${scope.teamId}::uuid
    order by snapshot_case.position
  `;
  const journeys = new Map<string, HistoryJourney>();
  for (const entry of cases) {
    if (!entry.suite_case_id) continue;
    const journey = journeys.get(entry.suite_case_id)
      ?? { key: entry.suite_case_id, title: entry.title, role: entry.role, revision: entry.suite_case_revision, caseIds: [] };
    journey.caseIds.push(entry.snapshot_case_id);
    journeys.set(entry.suite_case_id, journey);
  }
  return [...journeys.values()];
}

/** The Journeys whose walks the scope reads: a Suite Run's own, or every live one of the Project. */
export function historyJourneys(sql: postgres.Sql, scope: HistoryScope): Promise<HistoryJourney[]> {
  const { suiteRunId } = scope;
  return suiteRunId ? suiteRunJourneys(sql, { ...scope, suiteRunId }) : projectJourneys(sql, scope);
}

/**
 * Case Runs of these Journeys in this Project completed by `asOf`, newest
 * first, a bounded number per Journey, leaving out the scope's own run.
 */
export async function earlierCaseRuns(
  sql: postgres.Sql,
  scope: HistoryScope,
  keys: string[],
  perJourney = HISTORY_WALKS_PER_JOURNEY,
): Promise<HistoryCaseRun[]> {
  if (!keys.length) return [];
  return sql<HistoryCaseRun[]>`
    select id, suite_run_id, attempt, verdict, summary, failure_reason, checklist, role, completed_at,
      suite_case_id, suite_case_revision, title, source_suite_run_id, trigger_kind
    from (
      select case_run.id, case_run.suite_run_id, case_run.attempt, case_run.verdict, case_run.summary,
        case_run.failure_reason, case_run.checklist, case_run.role, case_run.completed_at,
        snapshot_case.suite_case_id, snapshot_case.suite_case_revision, snapshot_case.title,
        suite_run.source_suite_run_id, suite_run.trigger_kind,
        row_number() over (partition by snapshot_case.suite_case_id order by case_run.completed_at desc) as position
      from public.case_runs case_run
      join public.suite_snapshot_cases snapshot_case on snapshot_case.id = case_run.snapshot_case_id
      join public.suite_runs suite_run on suite_run.id = case_run.suite_run_id
      where case_run.team_id = ${scope.teamId}::uuid
        and suite_run.project_id = ${scope.projectId}
        and suite_run.id is distinct from ${scope.suiteRunId}
        and case_run.status = 'completed' and case_run.completed_at <= ${scope.asOf}
        and snapshot_case.suite_case_id = any(${keys}::uuid[])
    ) ranked
    where position <= ${perJourney}
    order by completed_at desc
  `;
}

/**
 * The step records (walk.json) these Case Runs registered by `asOf`, newest
 * first, whether or not each was kept: which walks there are, and their ids,
 * never change with an upload that settles later.
 */
export async function walkArtifactsOf(sql: postgres.Sql, scope: HistoryScope, caseRunIds: string[]): Promise<HistoryWalkArtifact[]> {
  if (!caseRunIds.length) return [];
  return sql<HistoryWalkArtifact[]>`
    select id, case_run_id, object_path, storage_status
    from public.artifacts
    where team_id = ${scope.teamId}::uuid and project_id = ${scope.projectId}
      and case_run_id = any(${caseRunIds}) and label = 'walk.json'
      and created_at <= ${scope.asOf}
    order by created_at desc
  `;
}

/** The newest runs finished by `asOf`, one light row each: the Suite Run's Suite's earlier ones, or the Project's for an Activity. */
function earlierRunsWindow(sql: postgres.Sql, scope: HistoryScope, limit: number): postgres.PendingQuery<HistoryRun[]> {
  if (scope.suiteRunId) {
    return sql<HistoryRun[]>`
      select earlier.id, earlier.source_suite_run_id, earlier.trigger_kind, earlier.verdict, earlier.created_at, earlier.completed_at
      from public.suite_runs current_run
      join public.suite_runs earlier on earlier.suite_id = current_run.suite_id and earlier.team_id = current_run.team_id
      where current_run.id = ${scope.suiteRunId} and current_run.team_id = ${scope.teamId}::uuid
        and earlier.id <> current_run.id and earlier.completed_at <= ${scope.asOf}
      order by earlier.created_at desc
      limit ${limit}
    `;
  }
  return sql<HistoryRun[]>`
    select id, source_suite_run_id, trigger_kind, verdict, created_at, completed_at
    from public.suite_runs
    where team_id = ${scope.teamId}::uuid and project_id = ${scope.projectId} and completed_at <= ${scope.asOf}
    order by created_at desc
    limit ${limit}
  `;
}

/** The newest runs finished by `asOf`, newest first. */
export function earlierRuns(sql: postgres.Sql, scope: HistoryScope, limit = HISTORY_RUNS): Promise<HistoryRun[]> {
  return earlierRunsWindow(sql, scope, limit);
}

/** The run of the newest HISTORY_RUNS that list_history names `id` (run-history.ts shortId: r and its sha256's first six hex digits). */
export async function earlierRunNamed(sql: postgres.Sql, scope: HistoryScope, id: string): Promise<HistoryRun | null> {
  const rows = await sql<HistoryRun[]>`
    select run.id, run.source_suite_run_id, run.trigger_kind, run.verdict, run.created_at, run.completed_at
    from (${earlierRunsWindow(sql, scope, HISTORY_RUNS)}) run
    where 'r' || left(encode(sha256(convert_to(run.id, 'UTF8')), 'hex'), 6) = ${id}
    order by run.created_at desc
    limit 1
  `;
  return rows[0] ?? null;
}

/** Each Case of these runs with its verdict, in the order the runs walked them. */
export async function runCasesOf(sql: postgres.Sql, teamId: string, runIds: string[]): Promise<HistoryRunCase[]> {
  if (!runIds.length) return [];
  return sql<HistoryRunCase[]>`
    select case_run.id, case_run.suite_run_id, case_run.verdict, case_run.summary, case_run.failure_reason,
      case_run.role, snapshot_case.title
    from public.case_runs case_run
    join public.suite_snapshot_cases snapshot_case on snapshot_case.id = case_run.snapshot_case_id
    where case_run.team_id = ${teamId}::uuid and case_run.suite_run_id = any(${runIds})
    order by snapshot_case.position, case_run.created_at
  `;
}
