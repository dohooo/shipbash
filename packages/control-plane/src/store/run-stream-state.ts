/**
 * What a Run's event stream reads on a tick that moved: exactly what its
 * frames carry. The run and the family member its live state comes from,
 * each Case at its latest walk — status, verdict, checkpoints, when the walk
 * started and ended — and the run's own log past the cursor, read as the
 * page's log route reads it (run-log.ts). The run page's read
 * (`getSuiteRunDetail`) carries every artifact, recording and narrative
 * besides; a frame is sent on every event, to every viewer, so the stream never
 * reads them. The family is read through run-family.ts, the same rule the page
 * reads it by.
 */
import type postgres from "postgres";

import type { TableRow } from "../generated/database/index.ts";
import type {
  CaseRunAttempt,
  RunnerArtifact,
  RunnerCaseRun,
  SuiteCaseRole,
  SuiteRunSummary,
} from "../types.ts";
import { iso } from "./normalize.ts";
import { latestFamilyCaseRunIds, readRunFamily, walkedCaseRows } from "./run-family.ts";
import { readLogLines, type RunLogEvent } from "./run-log.ts";
import { SUITE_RUN_ROW_COLUMNS, type SuiteRunRow, type Timestamp } from "./rows.ts";
import type { SelectedRow } from "./table-rows.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** Events one tick may carry; a longer backlog arrives over the next ticks. */
const RUN_TICK_EVENT_LIMIT = 1000;

export interface SuiteRunStreamState {
  /** The run the stream is of: its status ends the stream. */
  run: Pick<SuiteRunSummary, "id" | "status">;
  /** The family member the live state and the page's clock are read from. */
  activeRun: Pick<SuiteRunSummary, "status" | "startedAt" | "completedAt">;
  cases: Array<{
    snapshotCaseId: string;
    role: SuiteCaseRole;
    /** The latest walk across the family, or null when the Case was never walked. */
    caseRun: Pick<RunnerCaseRun, "id" | "status" | "verdict" | "checklist" | "startedAt" | "completedAt"> | null;
    /** Every walk of this Case across the family, oldest attempt first. */
    attempts: CaseRunAttempt[];
  }>;
  /**
   * The run's own events: a channel carries one run's log, the one its
   * sequence numbers count. A page reads the log of its family's active run
   * (`eventsRunId`) on that run's own channel.
   */
  events: RunLogEvent[];
  /** The stored files these events name. */
  artifacts: Array<Pick<RunnerArtifact, "id" | "kind" | "label">>;
}

type CaseRunTableRow = TableRow<"case_runs">;

type StreamCaseRow = SelectedRow<
  "suite_snapshot_cases",
  "role",
  {
    role: SuiteCaseRole;
    snapshot_case_id: string;
    case_run_id: CaseRunTableRow["id"] | null;
    status: RunnerCaseRun["status"] | null;
    verdict: RunnerCaseRun["verdict"];
    checklist: RunnerCaseRun["checklist"] | null;
    started_at: Timestamp | null;
    completed_at: Timestamp | null;
  }
>;

function streamCase(row: StreamCaseRow, attempts: ReadonlyMap<string, CaseRunAttempt[]>): SuiteRunStreamState["cases"][number] {
  return {
    snapshotCaseId: row.snapshot_case_id,
    role: row.role,
    caseRun: row.case_run_id && row.status && row.checklist
      ? {
          id: row.case_run_id,
          status: row.status,
          verdict: row.verdict,
          checklist: row.checklist,
          startedAt: iso(row.started_at, "case_runs.started_at"),
          completedAt: iso(row.completed_at, "case_runs.completed_at"),
        }
      : null,
    attempts: attempts.get(row.snapshot_case_id) ?? [],
  };
}

/**
 * Authorization-blind, like getSuiteRunDetail: the actor lane runs it under
 * RLS, and every statement is bound to the team.
 */
export async function readSuiteRunStreamState(
  sql: Queryable,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedRunId: string,
  eventsAfter: number,
): Promise<SuiteRunStreamState | null> {
  const [runRow] = await sql<SuiteRunRow[]>`
    select ${sql(SUITE_RUN_ROW_COLUMNS)}
    from public.suite_runs
    where team_id = ${scopedTeamId}::uuid
      and project_id = ${scopedProjectId}
      and id = ${scopedRunId}
    limit 1
  `;
  if (!runRow) return null;
  const family = await readRunFamily(sql, scopedTeamId, runRow);
  const caseRows = walkedCaseRows(runRow, await sql<StreamCaseRow[]>`
    select snapshot_case.id as snapshot_case_id, snapshot_case.role,
      case_run.id as case_run_id, case_run.status, case_run.verdict,
      case_run.checklist, case_run.started_at, case_run.completed_at
    from public.suite_snapshot_cases snapshot_case
    left join public.case_runs case_run
      on case_run.snapshot_case_id = snapshot_case.id
     and case_run.team_id = ${scopedTeamId}::uuid
     and case_run.id = any(${sql.array(latestFamilyCaseRunIds(family.attempts))}::text[])
    where snapshot_case.snapshot_id = ${runRow.suite_snapshot_id}
      and snapshot_case.team_id = ${scopedTeamId}::uuid
    order by snapshot_case.position, snapshot_case.id
  `);
  const log = await readLogLines(
    sql,
    { teamId: scopedTeamId, projectId: scopedProjectId, logRunId: runRow.id, after: eventsAfter },
    RUN_TICK_EVENT_LIMIT,
  );
  return {
    run: { id: runRow.id, status: runRow.status },
    activeRun: {
      status: family.activeRun.status,
      startedAt: iso(family.activeRun.started_at, "suite_runs.started_at"),
      completedAt: iso(family.activeRun.completed_at, "suite_runs.completed_at"),
    },
    cases: caseRows.map((row) => streamCase(row, family.attempts)),
    events: log.events,
    artifacts: log.artifacts,
  };
}
