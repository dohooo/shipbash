/**
 * The one way a Suite Run ends: its terminal status and verdict, its
 * completed_at, and the Runs it counts toward its team's monthly allowance
 * (run-units.ts), in one statement, so no ending leaves a finished run
 * without its count. Every path that ends a run comes here: completion, a
 * stranded run, a cancel with or without a lease, and the archived-project
 * sweep.
 */
import type { RunVerdict, SuiteCaseRole, SuiteRunStatus } from "@shipbash/contracts/database-contract-types";
import type postgres from "postgres";

import { runUnits } from "../run-units.ts";
import { SUITE_RUN_ROW_COLUMNS, type SuiteRunRow } from "./rows.ts";

export interface RunEnding {
  teamId: string;
  projectId: string;
  runId: string;
  status: "completed" | "canceled";
  verdict: RunVerdict;
  /** The statuses the run may end from; a run in any other is left as it is. */
  from: readonly SuiteRunStatus[];
  /** Why it ended, when the ending says; left as it was otherwise. */
  failureReason?: string;
  /** An ending that settles the run's evidence with it: a cancel before any walk. */
  finalized?: boolean;
}

/**
 * The walks the runner finished and timed in this run, as their completion
 * wrote them on the Case Runs (completeCaseRunForJob).
 */
async function finishedWalks(sql: postgres.TransactionSql, ending: RunEnding) {
  const rows = await sql<Array<{ role: SuiteCaseRole; case_id: string; walk_ms: number; journey_case_id: string | null }>>`
    select role, snapshot_case_id as case_id, walk_ms, journey_case_id
    from public.case_runs
    where suite_run_id = ${ending.runId} and team_id = ${ending.teamId}::uuid
      and walk_ms is not null
  `;
  return rows.map((row) => ({ role: row.role, caseId: row.case_id, walkMs: row.walk_ms, journeyCaseId: row.journey_case_id }));
}

/** Ends the run from one of `from`; null when it was in no such status. */
export async function endSuiteRun(sql: postgres.TransactionSql, ending: RunEnding): Promise<SuiteRunRow | null> {
  const units = runUnits(await finishedWalks(sql, ending));
  const rows = await sql<SuiteRunRow[]>`
    update public.suite_runs
    set status = ${ending.status}, verdict = ${ending.verdict}, completed_at = now(), run_units = ${units}
      ${ending.failureReason === undefined ? sql`` : sql`, failure_reason = ${ending.failureReason}`}
      ${ending.finalized ? sql`, finalization_status = 'finalized'` : sql``}
    where id = ${ending.runId} and team_id = ${ending.teamId}::uuid and project_id = ${ending.projectId}
      and status in ${sql(ending.from)}
    returning ${sql(SUITE_RUN_ROW_COLUMNS)}
  `;
  return rows[0] ?? null;
}
