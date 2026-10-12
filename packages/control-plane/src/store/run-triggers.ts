/**
 * Owner-triggered run dispatch beyond "run now": rerunning a historical Run
 * against its immutable snapshot, and retrying a single Case with a fresh
 * attempt number. Both are idempotent via findDispatchByKey. Keeping drafts
 * dispatches its verification in draft-keep.ts.
 */
import type postgres from "postgres";

import type { SuiteRunTriggerKind } from "@shipbash/contracts/database-contract-types";
import { nonEmpty } from "./normalize.ts";
import { createRunFromSnapshotTransaction, findDispatchByKey } from "./run-dispatch.ts";
import { isOnRunPage, rootRunId } from "./run-family.ts";
import type { NormalizedDispatchScope } from "./rows.ts";
import type { RunDispatchResult } from "../types.ts";
import { expectRow } from "./expect-row.ts";

export async function rerunHistoricalSuiteRun(
  sql: postgres.TransactionSql,
  scope: NormalizedDispatchScope,
  sourceSuiteRunId: string,
): Promise<RunDispatchResult> {
  const existing = await findDispatchByKey(sql, scope.teamId, scope.idempotencyKey);
  if (existing) return existing;
  const sources = await sql<Array<{ id: string; suite_id: string; suite_snapshot_id: string }>>`
    select id, suite_id, suite_snapshot_id
    from public.suite_runs
    where id = ${nonEmpty(sourceSuiteRunId, "sourceSuiteRunId")}
      and team_id = ${scope.teamId}::uuid
      and project_id = ${scope.projectId}
      and suite_id is not null
    for share
  `;
  const source = sources[0];
  if (!source) throw new Error("Historical Suite Run not found.");
  return createRunFromSnapshotTransaction(sql, {
    ...scope,
    suiteId: source.suite_id,
    snapshotId: source.suite_snapshot_id,
    sourceSuiteRunId: source.id,
    mode: "suite",
    triggerKind: "rerun",
  });
}

/** A retry asked from a walk that is not a Case Run of this Project, or not one its run's page shows. */
class SourceCaseRunNotFoundError extends Error {
  constructor() {
    super("Source Case Run not found.");
    this.name = "SourceCaseRunNotFoundError";
  }
}

/**
 * A Journey walked again, in place. The walk it starts from is one the page
 * it was asked from shows (`expectedRunId`): after a first retry the run's
 * page shows the Journey at the retry's walk, so a walk of the run's family
 * is accepted, not only one of the run itself.
 */
export async function retryCaseRun(
  sql: postgres.TransactionSql,
  scope: NormalizedDispatchScope,
  sourceCaseRunId: string,
  expectedRunId: string | null,
): Promise<RunDispatchResult> {
  const existing = await findDispatchByKey(sql, scope.teamId, scope.idempotencyKey);
  if (existing) return existing;
  const sources = await sql<Array<{
    suite_run_id: string;
    source_suite_run_id: string | null;
    trigger_kind: SuiteRunTriggerKind | null;
    suite_id: string;
    snapshot_id: string;
    snapshot_case_id: string;
    position: number;
  }>>`
    select source.suite_run_id, run.source_suite_run_id, run.trigger_kind,
      run.suite_id, run.suite_snapshot_id as snapshot_id,
      source.snapshot_case_id, source.position
    from public.case_runs source
    join public.suite_runs run on run.id = source.suite_run_id and run.team_id = source.team_id
    where source.id = ${nonEmpty(sourceCaseRunId, "sourceCaseRunId")}
      and source.team_id = ${scope.teamId}::uuid
      and run.project_id = ${scope.projectId}
      and run.suite_id is not null
    for share of source, run
  `;
  const source = sources[0];
  if (!source) throw new SourceCaseRunNotFoundError();
  const walk = {
    id: source.suite_run_id,
    sourceSuiteRunId: source.source_suite_run_id,
    triggerKind: source.trigger_kind,
  };
  if (expectedRunId !== null && !isOnRunPage(expectedRunId, walk)) throw new SourceCaseRunNotFoundError();
  const attemptRows = await sql<Array<{ next_attempt: number }>>`
    select coalesce(max(attempt), 0)::integer + 1 as next_attempt
    from public.case_runs
    where snapshot_case_id = ${source.snapshot_case_id}
  `;
  return createRunFromSnapshotTransaction(sql, {
    ...scope,
    suiteId: source.suite_id,
    snapshotId: source.snapshot_id,
    // Every attempt hangs off the root run, so a retry of a retry still lands
    // on the page the reader started from.
    sourceSuiteRunId: rootRunId(walk),
    mode: "case_retry",
    triggerKind: "case_retry",
    retryCase: {
      snapshotCaseId: source.snapshot_case_id,
      position: source.position,
      attempt: expectRow(attemptRows, "case_runs", "select").next_attempt,
    },
  });
}
