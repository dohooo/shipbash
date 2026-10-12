/**
 * Evidence hand-out reads: storage descriptors for available artifacts (scoped
 * through the run whose page lists them, or, for a bundle, the files of the
 * walks of one Journey), the scope a bundle's id names, and browser
 * recordings. The tenant-store facade owns actor scoping and the Project role
 * checks.
 */
import type postgres from "postgres";

import { EVIDENCE_ACTIVITY_KINDS } from "@shipbash/contracts/runtime/evidence-command.mjs";

import { readFamilyRunIds, rootRunId } from "./run-family.ts";
import type { SuiteRunRow } from "./rows.ts";

/** Where an available artifact's file is stored, and what to call it. */
export interface ArtifactDownloadDescriptor {
  objectPath: string;
  mimeType: string | null;
  label: string;
}

/** Where an available recording and its poster are stored. */
export interface BrowserRecordingDownloadDescriptor {
  objectPath: string;
  posterObjectPath: string | null;
}

/**
 * A file the run's page lists, found under the run the page names. The page
 * lists its family's walks (`readFamilyRunIds`): a Journey re-run in place
 * walks under a retry of its own, so a file of that walk is found under the
 * run as well as under the retry. A rerun of the whole Suite names a source
 * too, but it is a family of its own, and its files are not the run's. Every
 * run and file matched is the team's and the project's.
 */
export async function getArtifactDownloadDescriptor(
  sql: postgres.TransactionSql,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedRunId: string,
  scopedArtifactId: string,
): Promise<ArtifactDownloadDescriptor | null> {
  const [page] = await sql<Array<Pick<SuiteRunRow, "id" | "source_suite_run_id" | "trigger_kind">>>`
    select id, source_suite_run_id, trigger_kind
    from public.suite_runs
    where team_id = ${scopedTeamId}::uuid
      and project_id = ${scopedProjectId}
      and id = ${scopedRunId}
  `;
  if (!page) return null;
  const family = await readFamilyRunIds(sql, scopedTeamId, {
    id: page.id,
    sourceSuiteRunId: page.source_suite_run_id,
    triggerKind: page.trigger_kind,
  });
  const rows = await sql<Array<{
    object_path: string;
    mime_type: string | null;
    label: string;
  }>>`
    select artifact.object_path, artifact.mime_type, artifact.label
    from public.suite_runs run
    join public.case_runs case_run
      on case_run.suite_run_id = run.id and case_run.team_id = run.team_id
    join public.artifacts artifact
      on artifact.case_run_id = case_run.id and artifact.team_id = run.team_id
    where run.team_id = ${scopedTeamId}::uuid
      and run.project_id = ${scopedProjectId}
      and run.id in ${sql(family)}
      and artifact.project_id = ${scopedProjectId}
      and artifact.id = ${scopedArtifactId}
      and artifact.storage_status = 'available'
    limit 1
  `;
  const row = rows[0];
  return row ? {
    objectPath: row.object_path,
    mimeType: row.mime_type,
    label: row.label,
  } : null;
}

/**
 * The page a walk is shown on: the run it hangs off (the run it re-walked,
 * for a retry), in the project and team it belongs to, when the actor can see
 * the walk.
 */
export async function getCaseRunPage(
  sql: postgres.Sql | postgres.TransactionSql,
  caseRunId: string,
): Promise<{ teamId: string; projectId: string; runId: string } | null> {
  const [row] = await sql<Array<Pick<SuiteRunRow, "id" | "team_id" | "project_id" | "source_suite_run_id" | "trigger_kind">>>`
    select run.id, run.team_id, run.project_id, run.source_suite_run_id, run.trigger_kind
    from public.case_runs walk
    join public.suite_runs run on run.id = walk.suite_run_id and run.team_id = walk.team_id
    where walk.id = ${caseRunId}
    limit 1
  `;
  return row
    ? {
        teamId: row.team_id,
        projectId: row.project_id,
        runId: rootRunId({ id: row.id, sourceSuiteRunId: row.source_suite_run_id, triggerKind: row.trigger_kind }),
      }
    : null;
}

/**
 * The project and team of a walk or Discovery, when the actor can see it:
 * the Activity's own page names them, as a walk's run names them for a case
 * run.
 */
export async function getActivityPage(
  sql: postgres.Sql | postgres.TransactionSql,
  activityId: string,
): Promise<{ teamId: string; projectId: string } | null> {
  const [row] = await sql<Array<{ team_id: string; project_id: string }>>`
    select team_id::text, project_id
    from public.activities
    where id = ${activityId}::uuid
      and kind = any(${[...EVIDENCE_ACTIVITY_KINDS]}::text[])
    limit 1
  `;
  return row ? { teamId: row.team_id, projectId: row.project_id } : null;
}

/** A stored file of a walk, and where it is stored. */
export interface WalkArtifact {
  caseRunId: string;
  label: string;
  objectPath: string;
}

/** The files of these walks that reached Storage, oldest first. */
export async function listCaseRunArtifacts(
  sql: postgres.TransactionSql,
  scopedTeamId: string,
  scopedProjectId: string,
  caseRunIds: readonly string[],
): Promise<WalkArtifact[]> {
  if (caseRunIds.length === 0) return [];
  const rows = await sql<Array<{ case_run_id: string; label: string; object_path: string }>>`
    select case_run_id, label, object_path
    from public.artifacts
    where team_id = ${scopedTeamId}::uuid
      and project_id = ${scopedProjectId}
      and case_run_id in ${sql([...caseRunIds])}
      and storage_status = 'available'
    order by created_at, id
  `;
  return rows.map((row) => ({ caseRunId: row.case_run_id, label: row.label, objectPath: row.object_path }));
}

export async function getBrowserRecordingDownloadDescriptor(
  sql: postgres.TransactionSql,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedRecordingId: string,
): Promise<BrowserRecordingDownloadDescriptor | null> {
  const rows = await sql<Array<{ object_path: string; poster_object_path: string | null }>>`
    select object_path, poster_object_path
    from public.browser_recordings
    where id = ${scopedRecordingId}::uuid
      and team_id = ${scopedTeamId}::uuid
      and project_id = ${scopedProjectId}
      and storage_status = 'available'
    limit 1
  `;
  const row = rows[0];
  return row ? { objectPath: row.object_path, posterObjectPath: row.poster_object_path } : null;
}
