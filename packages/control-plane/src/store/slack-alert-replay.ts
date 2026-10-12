/**
 * Where a walk's exported replay lives: the `case-replay.mp4` a failed
 * journey's Slack reply carries, and the one a conversation's thread is sent
 * when the owner asks for it. It is the walk's one `video` artifact, known by
 * its name — the raw recording's segments are MP4 too.
 *
 * Authorization-blind, like its neighbours: the caller is the system-scoped
 * sender or a conversation's turn, and the statement is bound to the team and
 * project.
 */
import type postgres from "postgres";

import { CASE_REPLAY_FILE } from "@shipbash/contracts/runtime/browser-recording-format.mjs";
import { nonEmpty } from "./normalize.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** Where a replay lives in the artifacts bucket, and how big the bucket says it is. */
export interface StoredReplay {
  objectPath: string;
  sizeBytes: number | null;
}

/** The stored replay of one walk, or null when it left none that is available. */
export async function selectSlackAlertReplay(
  sql: Queryable,
  input: { teamId: string; projectId: string; caseRunId: string },
): Promise<StoredReplay | null> {
  const rows = await sql<Array<{ object_path: string; size_bytes: number | string | null }>>`
    select object_path, size_bytes
    from public.artifacts
    where team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and project_id = ${nonEmpty(input.projectId, "projectId")}
      and case_run_id = ${nonEmpty(input.caseRunId, "caseRunId")}
      and kind = 'video' and label = ${CASE_REPLAY_FILE} and storage_status = 'available'
    order by created_at desc
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    objectPath: row.object_path,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
  };
}

/** A Journey run of the project as a conversation's thread is sent its replay: its run, and its Journey's title. */
export interface JourneyRun {
  runId: string;
  title: string;
}

/** One Journey run of the project, or null when the project has none by that id; its replay is selectSlackAlertReplay's. */
export async function selectJourneyRun(
  sql: Queryable,
  input: { teamId: string; projectId: string; caseRunId: string },
): Promise<JourneyRun | null> {
  const rows = await sql<Array<{ run_id: string; title: string }>>`
    select run.id as run_id, snapshot_case.title
    from public.case_runs case_run
    join public.suite_runs run on run.id = case_run.suite_run_id
    join public.suite_snapshot_cases snapshot_case on snapshot_case.id = case_run.snapshot_case_id
    where case_run.id = ${nonEmpty(input.caseRunId, "caseRunId")}
      and run.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and run.project_id = ${nonEmpty(input.projectId, "projectId")}
  `;
  const row = rows[0];
  return row ? { runId: row.run_id, title: row.title } : null;
}
