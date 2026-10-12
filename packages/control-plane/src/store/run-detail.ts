/**
 * The full Run report read: the membership-scoped run row, every snapshot
 * Case joined to its latest Case Run attempt across the run's family — or to
 * the one earlier attempt the caller asked for (case retries hang off the run
 * they re-walk; a retry's own page prunes never-walked siblings), the attempts
 * behind each of them, and grouped artifacts and recordings — fetched here,
 * assembled by buildSuiteRunDetail. The log of the family's active run is read
 * apart, by the readers that show it (run-log.ts), and the event stream reads
 * its own narrow tick (run-stream-state.ts). The tenant-store facade owns actor scoping.
 */
import type postgres from "postgres";

import type { ReproducedRunCount } from "@shipbash/contracts/database-contract-types";
import type { TableRow } from "../generated/database/index.ts";
import { mapRunnerCaseRun } from "./dispatch-capabilities.ts";
import { renderJourneySteps } from "@shipbash/contracts/runtime/journey-steps.mjs";
import { iso, journeySteps } from "./normalize.ts";
import { readRunFamily, shownFamilyCaseRunIds, walkedCaseRows } from "./run-family.ts";
import { BROWSER_RECORDING_ROW_COLUMNS, type BrowserRecordingRow, type SuiteRunRow, type Timestamp } from "./rows.ts";
import { mapSuiteRun } from "./suite-maps.ts";
import type { SelectedRow } from "./table-rows.ts";
import { mapBrowserRecording } from "./workspace-maps.ts";
import type {
  CaseCodeEvidence,
  CaseRunAttempt,
  RunnerArtifact,
  RunnerCaseRun,
  SuiteRunDetail,
} from "../types.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

type RunDetailRow = SuiteRunRow & {
  project_name: string;
  suite_name: string | null;
  production_url: string;
};

type SnapshotCaseTableRow = TableRow<"suite_snapshot_cases">;
type CaseRunTableRow = TableRow<"case_runs">;

type RunDetailCaseRow = SelectedRow<
  "suite_snapshot_cases",
  "position" | "title" | "step_list" | "role",
  {
    role: SuiteRunDetail["cases"][number]["role"];
    snapshot_case_id: SnapshotCaseTableRow["id"];
    source_case_id: SnapshotCaseTableRow["suite_case_id"];
    scope_suite_case_id: SnapshotCaseTableRow["scope_suite_case_id"];
    case_run_id: CaseRunTableRow["id"] | null;
    case_run_suite_run_id: CaseRunTableRow["suite_run_id"] | null;
    case_run_snapshot_case_id: CaseRunTableRow["snapshot_case_id"] | null;
    case_run_position: CaseRunTableRow["position"] | null;
    attempt: CaseRunTableRow["attempt"] | null;
    status: RunnerCaseRun["status"] | null;
    verdict: RunnerCaseRun["verdict"];
    checklist: RunnerCaseRun["checklist"] | null;
    summary: CaseRunTableRow["summary"] | null;
    failure_reason: CaseRunTableRow["failure_reason"] | null;
    reproduced_runs: ReproducedRunCount | null;
    code_evidence: CaseCodeEvidence | null;
    case_run_created_at: Timestamp | null;
    case_run_started_at: Timestamp | null;
    case_run_completed_at: Timestamp | null;
  }
>;

type RunDetailArtifactRow = SelectedRow<
  "artifacts",
  | "id"
  | "case_run_id"
  | "kind"
  | "label"
  | "mime_type"
  | "size_bytes"
  | "storage_status"
  | "created_at",
  {
  kind: RunnerArtifact["kind"];
  size_bytes: number | string | null;
  storage_status: RunnerArtifact["storageStatus"];
  created_at: Timestamp;
  }
>;

export interface RunDetailOptions {
  /**
   * A Case Run of this run's family the page was asked to show. That Journey's
   * row is then that walk — its checklist, artifacts and recording — while
   * every other Journey stays at its latest attempt, and the run's verdict,
   * status, active run and attempt lists are untouched. An id the family does not
   * hold names no row, so the page reads as it would without it.
   */
  attemptCaseRunId?: string | null;
}

/**
 * Authorization-blind, like the four reads beneath it: the actor lane runs the
 * whole aggregate under RLS (`suite_runs_select_member` and its siblings), and
 * the system lane — the Slack sender, which has no actor — runs it as the
 * service role. The statement is bound to the team either way, so a run of
 * another team is not found even where RLS does not apply.
 */
export async function getSuiteRunDetail(
  sql: Queryable,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedRunId: string,
  options: RunDetailOptions = {},
): Promise<SuiteRunDetail | null> {
  const runRows = await sql<RunDetailRow[]>`
    select run.id, run.team_id, run.project_id, run.suite_id, run.suite_snapshot_id,
      run.source_suite_run_id,
      run.status, run.verdict, run.finalization_status, run.trigger_kind,
      run.created_at, run.started_at, run.completed_at,
      coalesce(share.is_public, false) as is_public,
      project.name as project_name, suite.name as suite_name,
      snapshot.production_url
    from public.suite_runs run
    left join public.suite_run_shares share on share.run_id = run.id and share.team_id = run.team_id
    join public.projects project
      on project.id = run.project_id and project.team_id = run.team_id
    join public.suite_snapshots snapshot
      on snapshot.id = run.suite_snapshot_id and snapshot.team_id = run.team_id
    left join public.suites suite
      on suite.id = run.suite_id and suite.team_id = run.team_id
    where run.team_id = ${scopedTeamId}::uuid
      and run.project_id = ${scopedProjectId}
      and run.id = ${scopedRunId}
    limit 1
  `;
  const runRow = runRows[0];
  if (!runRow) return null;

  const family = await readRunFamily(sql, scopedTeamId, runRow);
  const caseRows = await sql<RunDetailCaseRow[]>`
    select
      snapshot_case.id as snapshot_case_id, snapshot_case.position,
      snapshot_case.title, snapshot_case.step_list, snapshot_case.role,
      snapshot_case.suite_case_id as source_case_id, snapshot_case.scope_suite_case_id,
      case_run.id as case_run_id,
      case_run.suite_run_id as case_run_suite_run_id,
      case_run.snapshot_case_id as case_run_snapshot_case_id,
      case_run.position as case_run_position,
      case_run.attempt, case_run.status, case_run.verdict,
      case_run.checklist, case_run.summary, case_run.failure_reason,
      case_run.reproduced_runs, case_run.code_evidence,
      case_run.created_at as case_run_created_at,
      case_run.started_at as case_run_started_at,
      case_run.completed_at as case_run_completed_at
    from public.suite_snapshot_cases snapshot_case
    left join public.case_runs case_run
      on case_run.snapshot_case_id = snapshot_case.id
     and case_run.team_id = ${scopedTeamId}::uuid
     and case_run.id = any(${sql.array(shownFamilyCaseRunIds(family.attempts, options.attemptCaseRunId ?? null))}::text[])
    where snapshot_case.snapshot_id = ${runRow.suite_snapshot_id}
      and snapshot_case.team_id = ${scopedTeamId}::uuid
    order by snapshot_case.position, snapshot_case.id
  `;
  const walkedRows = walkedCaseRows(runRow, caseRows);
  const caseRunIds = walkedRows.flatMap((row) => row.case_run_id ? [row.case_run_id] : []);
  const artifactRows = caseRunIds.length === 0 ? [] : await sql<RunDetailArtifactRow[]>`
    select artifact.id, artifact.case_run_id, artifact.kind, artifact.label,
      artifact.mime_type, artifact.size_bytes, artifact.storage_status,
      artifact.created_at
    from public.artifacts artifact
    where artifact.team_id = ${scopedTeamId}::uuid
      and artifact.project_id = ${scopedProjectId}
      and artifact.case_run_id in ${sql(caseRunIds)}
    order by artifact.created_at, artifact.id
  `;
  const recordingRows = caseRunIds.length === 0 ? [] : await sql<BrowserRecordingRow[]>`
    select ${sql(BROWSER_RECORDING_ROW_COLUMNS)}
    from public.browser_recordings
    where team_id = ${scopedTeamId}::uuid
      and project_id = ${scopedProjectId}
      and case_run_id in ${sql(caseRunIds)}
  `;
  return buildSuiteRunDetail({
    runRow,
    activeRunRow: family.activeRun,
    caseRows: walkedRows,
    attempts: family.attempts,
    artifactRows,
    recordingRows,
  });
}

/** The Case Run attempt this row settled on, or null when the Case never started. */
function caseRunOf(row: RunDetailCaseRow): RunnerCaseRun | null {
  return row.case_run_id && row.case_run_suite_run_id &&
      row.case_run_snapshot_case_id && row.case_run_position !== null &&
      row.attempt !== null && row.status && row.checklist && row.case_run_created_at
    ? mapRunnerCaseRun({
        id: row.case_run_id,
        suite_run_id: row.case_run_suite_run_id,
        snapshot_case_id: row.case_run_snapshot_case_id,
        position: row.case_run_position,
        attempt: row.attempt,
        status: row.status,
        verdict: row.verdict,
        checklist: row.checklist,
        summary: row.summary,
        failure_reason: row.failure_reason,
        reproduced_runs: row.reproduced_runs ?? 1,
        code_evidence: row.code_evidence,
        created_at: row.case_run_created_at,
        started_at: row.case_run_started_at,
        completed_at: row.case_run_completed_at,
      })
    : null;
}

function buildSuiteRunDetail({
  runRow,
  activeRunRow,
  caseRows,
  attempts,
  artifactRows,
  recordingRows,
}: {
  runRow: RunDetailRow;
  activeRunRow: SuiteRunRow;
  caseRows: RunDetailCaseRow[];
  attempts: ReadonlyMap<string, CaseRunAttempt[]>;
  artifactRows: RunDetailArtifactRow[];
  recordingRows: BrowserRecordingRow[];
}): SuiteRunDetail {
  const artifactsByCaseRun = new Map<string, RunnerArtifact[]>();
  for (const row of artifactRows) {
    const artifact: RunnerArtifact = {
      id: row.id,
      caseRunId: row.case_run_id,
      kind: row.kind,
      label: row.label,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      storageStatus: row.storage_status,
      createdAt: iso(row.created_at, "artifacts.created_at"),
    };
    const group = artifactsByCaseRun.get(row.case_run_id) ?? [];
    group.push(artifact);
    artifactsByCaseRun.set(row.case_run_id, group);
  }
  const recordingsByCaseRun = new Map(
    recordingRows.flatMap((row) => row.case_run_id
      ? [[row.case_run_id, mapBrowserRecording(row)] as const]
      : []),
  );
  // The snapshot froze the scope as the Suite Case id; the report reads it
  // as the sibling snapshot Case, the same way the run input does.
  const snapshotIdBySource = new Map(caseRows.map((row) => [row.source_case_id, row.snapshot_case_id]));
  return {
    run: mapSuiteRun(runRow),
    activeRun: mapSuiteRun(activeRunRow),
    projectName: runRow.project_name,
    suiteName: runRow.suite_name,
    productionUrl: runRow.production_url,
    cases: caseRows.map((row) => {
      const caseRun = caseRunOf(row);
      return {
        snapshotCaseId: row.snapshot_case_id,
        suiteCaseId: row.source_case_id,
        position: row.position,
        title: row.title,
        steps: renderJourneySteps(journeySteps(row.step_list)),
        role: row.role,
        scopeCaseId: row.scope_suite_case_id === null ? null : snapshotIdBySource.get(row.scope_suite_case_id) ?? null,
        caseRun,
        attempts: attempts.get(row.snapshot_case_id) ?? [],
        artifacts: caseRun ? artifactsByCaseRun.get(caseRun.id) ?? [] : [],
        recording: caseRun ? recordingsByCaseRun.get(caseRun.id) ?? null : null,
      };
    }),
  };
}
