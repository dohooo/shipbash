/**
 * A run and the attempts hung off it, read as one.
 *
 * The data stays immutable — every walk keeps its own `case_runs` row and
 * every re-run its own `suite_runs` row — and the page is what moves: a run's
 * family is the run plus every case retry pointed at it, and the page shows
 * each Case at its latest attempt across that family — or at the one earlier
 * walk it was asked for, marked as superseded. A retry's own page is
 * its own family, so a link to a retry still shows exactly what that retry
 * walked. The operator's run detail, the public share page and the files a
 * run's page hands out all read the family through here, so none can invent
 * its own rule for it.
 */
import type postgres from "postgres";

import type { SuiteRunTriggerKind } from "@shipbash/contracts/database-contract-types";
import type { CaseRunAttempt } from "../types.ts";
import { iso } from "./normalize.ts";
import { SUITE_RUN_ROW_COLUMNS, type SuiteRunRow, type Timestamp } from "./rows.ts";
import type { SelectedRow } from "./table-rows.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** A run as the family rule reads it: its id, what it is, and what it came from. */
export interface FamilyRunRef {
  id: string;
  sourceSuiteRunId: string | null;
  triggerKind: SuiteRunTriggerKind | null;
}

/**
 * Whether this run is an attempt of another one. A rerun of a whole Suite also
 * names a source, but it is a run of everything rather than an attempt — so
 * carrying a source is not what makes a run part of another's family; being a
 * case retry is.
 */
function isCaseRetry(run: FamilyRunRef): boolean {
  return run.triggerKind === "case_retry";
}

/**
 * The run whose page aggregates this one: itself, unless it is a case retry,
 * and then the run it re-walked.
 */
export function rootRunId(run: FamilyRunRef): string {
  return isCaseRetry(run) ? run.sourceSuiteRunId ?? run.id : run.id;
}

/** Whether `run`'s walks are ones the page of `pageRunId` shows: that run's own, or a retry hung off it. */
export function isOnRunPage(pageRunId: string, run: FamilyRunRef): boolean {
  return run.id === pageRunId || rootRunId(run) === pageRunId;
}

const RUNS_IN_FLIGHT = new Set(["queued", "running", "waiting_for_auth", "canceling"]);

type FamilyAttemptRow = SelectedRow<
  "case_runs",
  "id" | "suite_run_id" | "snapshot_case_id" | "attempt" | "status" | "verdict" | "completed_at",
  {
    status: CaseRunAttempt["status"];
    verdict: CaseRunAttempt["verdict"];
    completed_at: Timestamp | null;
  }
>;

/**
 * The case retries hung off this run, oldest first. A run that is itself a
 * retry has none of its own: `retryCaseRun` points every attempt at the root,
 * which is the run this one would be aggregated into.
 */
export async function readRunRetries(
  sql: Queryable,
  scopedTeamId: string,
  run: FamilyRunRef,
): Promise<SuiteRunRow[]> {
  if (isCaseRetry(run)) return [];
  return sql<SuiteRunRow[]>`
    select ${sql(SUITE_RUN_ROW_COLUMNS)}
    from public.suite_runs
    where team_id = ${scopedTeamId}::uuid
      and source_suite_run_id = ${run.id}
      and mode = 'case_retry'
    order by created_at, id
  `;
}

/** Every run whose Case Runs the page reads as one: the run, then its retries. */
function familyRunIds(run: { id: string }, retries: readonly { id: string }[]): string[] {
  return [run.id, ...retries.map((retry) => retry.id)];
}

/** The runs whose walks a run's page lists: its family, read by that same rule. */
export async function readFamilyRunIds(
  sql: Queryable,
  scopedTeamId: string,
  run: FamilyRunRef,
): Promise<string[]> {
  return familyRunIds(run, await readRunRetries(sql, scopedTeamId, run));
}

/** A run row read as the family rule reads it. */
function familyRunRef(run: SuiteRunRow): FamilyRunRef {
  return {
    id: run.id,
    sourceSuiteRunId: run.source_suite_run_id,
    triggerKind: run.trigger_kind,
  };
}

/**
 * The member the page reads its live state from — status, log, stream — which
 * is the newest attempt still in flight, and the run itself once they have
 * all settled.
 */
export function activeFamilyRun(root: SuiteRunRow, retries: readonly SuiteRunRow[]): SuiteRunRow {
  return retries.filter((retry) => RUNS_IN_FLIGHT.has(retry.status)).at(-1) ?? root;
}

/**
 * The member a family's page shows live, while one is: its active run, if that
 * run is still in flight, and null once the whole family has settled.
 */
export async function readLiveFamilyRun(
  sql: Queryable,
  scopedTeamId: string,
  root: SuiteRunRow,
): Promise<SuiteRunRow | null> {
  const active = activeFamilyRun(root, await readRunRetries(sql, scopedTeamId, familyRunRef(root)));
  return RUNS_IN_FLIGHT.has(active.status) ? active : null;
}

/**
 * The snapshot Cases a run's page lists, from rows joined to the walks it
 * shows: every one, unless the run is a case retry. A retry re-walks exactly
 * one Journey; its snapshot siblings without a Case Run are not part of it,
 * and listing them would show Journeys stuck "Queued" in a settled report.
 */
export function walkedCaseRows<Row extends { case_run_id: string | null }>(run: SuiteRunRow, rows: Row[]): Row[] {
  return isCaseRetry(familyRunRef(run)) ? rows.filter((row) => row.case_run_id !== null) : rows;
}

/** The runs of a family as rows: the run, then its retries. */
export async function readFamilyRuns(
  sql: Queryable,
  scopedTeamId: string,
  root: SuiteRunRow,
): Promise<SuiteRunRow[]> {
  return [root, ...await readRunRetries(sql, scopedTeamId, familyRunRef(root))];
}

export interface RunFamily {
  activeRun: SuiteRunRow;
  attempts: Map<string, CaseRunAttempt[]>;
}

/** The whole family of a run, as the run detail reads it. */
export async function readRunFamily(
  sql: Queryable,
  scopedTeamId: string,
  root: SuiteRunRow,
): Promise<RunFamily> {
  const retries = await readRunRetries(sql, scopedTeamId, familyRunRef(root));
  return {
    activeRun: activeFamilyRun(root, retries),
    attempts: await readFamilyAttempts(sql, scopedTeamId, familyRunIds(root, retries)),
  };
}

/**
 * The Case Run each snapshot Case is shown at: its latest attempt anywhere in
 * the family, which is the last of each list `readFamilyAttempts` returns.
 * The operator's report, the share page and the media a share link serves all
 * pick their rows by these ids, so none of them can show a walk another one
 * has already superseded.
 */
export function latestFamilyCaseRunIds(attempts: ReadonlyMap<string, CaseRunAttempt[]>): string[] {
  return shownFamilyCaseRunIds(attempts, null);
}

/**
 * The same list when the page was asked to show one earlier walk: that Case
 * Run in place of its own Case's latest attempt, every other Case still at
 * its latest. An id no attempt list holds names no row, so the page reads
 * exactly as it would without one — a link to a walk of another family, or to
 * a walk that no longer exists, still opens the run.
 */
export function shownFamilyCaseRunIds(
  attempts: ReadonlyMap<string, CaseRunAttempt[]>,
  attemptCaseRunId: string | null,
): string[] {
  return [...attempts.values()].flatMap((walks) => {
    const shown = walks.find((walk) => walk.caseRunId === attemptCaseRunId) ?? walks.at(-1);
    return shown ? [shown.caseRunId] : [];
  });
}

/** Every walk of every Case across the family, by snapshot Case, oldest attempt first. */
export async function readFamilyAttempts(
  sql: Queryable,
  scopedTeamId: string,
  runIds: readonly string[],
): Promise<Map<string, CaseRunAttempt[]>> {
  const rows = await sql<FamilyAttemptRow[]>`
    select id, suite_run_id, snapshot_case_id, attempt, status, verdict, completed_at
    from public.case_runs
    where team_id = ${scopedTeamId}::uuid
      and suite_run_id in ${sql(runIds)}
    order by snapshot_case_id, attempt
  `;
  const byCase = new Map<string, CaseRunAttempt[]>();
  for (const row of rows) {
    const attempts = byCase.get(row.snapshot_case_id) ?? [];
    attempts.push({
      caseRunId: row.id,
      runId: row.suite_run_id,
      attempt: row.attempt,
      status: row.status,
      verdict: row.verdict,
      completedAt: iso(row.completed_at, "case_runs.completed_at"),
    });
    byCase.set(row.snapshot_case_id, attempts);
  }
  return byCase;
}
