/**
 * Run dispatch identity and creation: the normalized dispatch scope, the
 * idempotency-key and outstanding-run probes that make dispatch exactly-once,
 * and the transaction that turns a snapshot into a queued Suite Run plus its
 * dispatch job, once the team's monthly Run allowance admits it
 * (run-quota.ts). Callers own authorization and the transaction (tenant-store
 * facade).
 */
import { randomUUID } from "node:crypto";

import type postgres from "postgres";

import { generatedTextId, nonEmpty, sha256, timestamp } from "./normalize.ts";
import { type NormalizedDispatchScope, SUITE_RUN_ROW_COLUMNS, type SuiteRunRow } from "./rows.ts";
import { assertRunQuotaAvailable } from "./run-quota.ts";
import { mapSuiteRun } from "./suite-maps.ts";
import type { DispatchIdentityInput, RunDispatchResult } from "../types.ts";
import { expectRow } from "./expect-row.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

export function normalizeDispatchScope(
  teamId: string,
  projectId: string,
  input: DispatchIdentityInput,
  runQuota: boolean,
): NormalizedDispatchScope {
  const idempotencyKey = nonEmpty(input.idempotencyKey, "idempotencyKey");
  if (idempotencyKey.length > 500) throw new Error("idempotencyKey exceeds 500 characters.");
  const expiresAt = timestamp(input.expiresAt, "expiresAt");
  if (new Date(expiresAt) <= new Date()) throw new Error("expiresAt must be in the future.");
  return {
    teamId: nonEmpty(teamId, "teamId"),
    projectId: nonEmpty(projectId, "projectId"),
    idempotencyKey,
    identityHash: sha256(input.identityHash, "identityHash"),
    expiresAt,
    promptContractVersions: input.promptContractVersions,
    modelContract: input.modelContract,
    runQuota,
  };
}

export async function findDispatchByKey(
  sql: Queryable,
  teamId: string,
  idempotencyKey: string,
): Promise<RunDispatchResult | null> {
  const rows = await sql<Array<SuiteRunRow & { dispatch_job_id: string }>>`
    select run.id, run.team_id, run.project_id, run.suite_id,
      run.suite_snapshot_id, run.source_suite_run_id,
      run.status, run.verdict, run.finalization_status,
      run.trigger_kind, run.created_at, run.started_at, run.completed_at,
      job.id as dispatch_job_id
    from public.dispatch_jobs job
    join public.suite_runs run
      on run.id = job.suite_run_id and run.team_id = job.team_id
    where job.team_id = ${teamId}::uuid
      and job.idempotency_key = ${idempotencyKey}
      and job.kind = 'suite_run'
    limit 1
  `;
  if (!rows[0]) return null;
  return {
    run: mapSuiteRun(rows[0]),
    snapshotId: rows[0].suite_snapshot_id,
    dispatchJobId: rows[0].dispatch_job_id,
    created: false,
    reusedOutstanding: false,
  };
}

export async function findOutstandingRun(
  sql: Queryable,
  teamId: string,
  suiteId: string,
): Promise<RunDispatchResult | null> {
  const rows = await sql<Array<SuiteRunRow & { dispatch_job_id: string }>>`
    select run.id, run.team_id, run.project_id, run.suite_id,
      run.suite_snapshot_id, run.source_suite_run_id,
      run.status, run.verdict, run.finalization_status,
      run.trigger_kind, run.created_at, run.started_at, run.completed_at,
      job.id as dispatch_job_id
    from public.suite_runs run
    join public.dispatch_jobs job
      on job.suite_run_id = run.id and job.team_id = run.team_id
    where run.team_id = ${teamId}::uuid
      and run.suite_id = ${suiteId}::uuid
      and run.status in ('queued', 'running', 'waiting_for_auth', 'canceling')
    order by run.created_at, run.id
    limit 1
  `;
  if (!rows[0]) return null;
  return {
    run: mapSuiteRun(rows[0]),
    snapshotId: rows[0].suite_snapshot_id,
    dispatchJobId: rows[0].dispatch_job_id,
    created: false,
    reusedOutstanding: true,
  };
}

export async function createRunFromSnapshotTransaction(
  sql: postgres.TransactionSql,
  input: NormalizedDispatchScope & {
    suiteId: string;
    snapshotId: string;
    sourceSuiteRunId: string | null;
    mode: "suite" | "case_retry";
    triggerKind: "initial_confirmation" | "manual" | "scheduled" | "rerun" | "case_retry";
    scheduledFor?: string | null;
    retryCase?: { snapshotCaseId: string; position: number; attempt: number };
  },
  suiteAlreadyLocked = false,
): Promise<RunDispatchResult> {
  const existing = await findDispatchByKey(sql, input.teamId, input.idempotencyKey);
  if (existing) return existing;
  if (!suiteAlreadyLocked) {
    const suites = await sql`
      select 1 from public.suites
      where id = ${input.suiteId}::uuid
        and team_id = ${input.teamId}::uuid
        and project_id = ${input.projectId}
      for update
    `;
    if (!suites[0]) throw new Error("Suite not found.");
    const afterLock = await findDispatchByKey(sql, input.teamId, input.idempotencyKey);
    if (afterLock) return afterLock;
    const outstanding = await findOutstandingRun(sql, input.teamId, input.suiteId);
    if (outstanding) return outstanding;
  }
  // Every verification run starts here, so the monthly allowance holds for all of them.
  await assertRunQuotaAvailable(sql, input.teamId, input.runQuota);
  const runId = generatedTextId("suite_run");
  const runRows = await sql<SuiteRunRow[]>`
    insert into public.suite_runs (
      id, project_id, team_id, suite_snapshot_id, suite_id, mode,
      source_suite_run_id, status, finalization_status, dispatch_key,
      trigger_kind, scheduled_for
    ) values (
      ${runId}, ${input.projectId}, ${input.teamId}::uuid, ${input.snapshotId},
      ${input.suiteId}::uuid, ${input.mode}, ${input.sourceSuiteRunId},
      'queued', 'pending', ${input.idempotencyKey}, ${input.triggerKind},
      ${input.scheduledFor ?? null}
    )
    returning ${sql(SUITE_RUN_ROW_COLUMNS)}
  `;
  if (input.retryCase) {
    await sql`
      insert into public.case_runs (
        id, suite_run_id, snapshot_case_id, team_id, position,
        attempt, status, role, checklist
      ) values (
        ${generatedTextId("case_run")}, ${runId}, ${input.retryCase.snapshotCaseId},
        ${input.teamId}::uuid, ${input.retryCase.position},
        ${input.retryCase.attempt}, 'queued', 'journey', '[]'::jsonb
      )
    `;
  }
  const jobId = randomUUID();
  await sql`
    insert into public.dispatch_jobs (
      id, team_id, project_id, kind, suite_run_id, idempotency_key,
      identity_hash, write_scope, status, expires_at
    ) values (
      ${jobId}, ${input.teamId}::uuid, ${input.projectId}, 'suite_run', ${runId},
      ${input.idempotencyKey}, ${input.identityHash},
      ${sql.json({
        teamId: input.teamId,
        projectId: input.projectId,
        suiteRunId: runId,
      })},
      'queued', ${input.expiresAt}
    )
  `;
  return {
    run: mapSuiteRun(expectRow(runRows, "suite_runs", "insert")),
    snapshotId: input.snapshotId,
    dispatchJobId: jobId,
    created: true,
    reusedOutstanding: false,
  };
}
