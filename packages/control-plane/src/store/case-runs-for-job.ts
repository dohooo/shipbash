/**
 * Case Run writes under a dispatch lease: start (checklist anchored to the
 * Journey checkpoints, attempts accounted), checklist transitions guarded by
 * checklistTransition, trust markers, and terminal completion.
 */
import type postgres from "postgres";

import type { SuiteRunTriggerKind } from "@shipbash/contracts/database-contract-types";
import { CHECKLISTLESS_VERDICTS } from "@shipbash/contracts/runtime/checklist-contract.mjs";
import { resolveRunId } from "@shipbash/contracts/runtime/run-id-contract.mjs";
import {
  lockSuiteRunJob,
  mapRunnerCaseRun,
  requireScopedCaseRun,
} from "./dispatch-capabilities.ts";
import {
  checklistTransition,
  generatedTextId,
  journeyCheckpoints,
  nonEmpty,
  normalizeChecklist,
  positiveInteger,
} from "./normalize.ts";
import { CASE_RUN_ROW_COLUMNS, type DispatchJobRow, type RunnerCaseRunRow } from "./rows.ts";
import { rootRunId } from "./run-family.ts";
import type { DispatchJobLeaseCapability, RunnerCaseRun } from "../types.ts";
import { expectRow } from "./expect-row.ts";
import type { CompleteCaseRunForJobInput, UpdateCaseTrustForJobInput } from "./job-store-inputs.ts";

export async function startCaseRunForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  snapshotCaseId: string,
  attempt?: number,
): Promise<RunnerCaseRun> {
  const scopedSnapshotCaseId = nonEmpty(snapshotCaseId, "snapshotCaseId");
  const requestedAttempt = attempt === undefined ? null : positiveInteger(attempt, "attempt");
  return sql.begin(async (sql) => {
    const job = await lockSuiteRunJob(sql, capability);
    const targetRows = await sql<Array<{
      position: number; mode: "suite" | "case_retry"; checkpoints: unknown; role: string;
      run_id: string; trigger_kind: SuiteRunTriggerKind | null; source_suite_run_id: string | null;
    }>>`
      select snapshot_case.position, run.mode, snapshot_case.checkpoints, snapshot_case.role,
        run.id as run_id, run.trigger_kind, run.source_suite_run_id
      from public.suite_runs run
      join public.suite_snapshot_cases snapshot_case
        on snapshot_case.snapshot_id = run.suite_snapshot_id
       and snapshot_case.team_id = run.team_id
      where run.id = ${job.suite_run_id}
        and run.team_id = ${job.team_id}::uuid
        and run.project_id = ${job.project_id}
        and snapshot_case.id = ${scopedSnapshotCaseId}
      for share of run, snapshot_case
    `;
    const target = targetRows[0];
    if (!target) throw new Error("Snapshot Case is outside the Job write scope.");
    // Anchor the run Checklist to the Journey checkpoints from the very
    // start. Every (re)start resets it to all-pending because the Runner
    // re-executes the Case from scratch and reports fresh transitions. A goal
    // names this run's data by the family's run id where the Suite wrote the
    // placeholder, exactly as the Runner reads it (run-id-contract.mjs).
    const familyRunId = rootRunId({
      id: target.run_id, triggerKind: target.trigger_kind, sourceSuiteRunId: target.source_suite_run_id,
    });
    const initialChecklist = journeyCheckpoints(target.checkpoints).map((checkpoint) => ({
      id: checkpoint.id,
      goal: resolveRunId(checkpoint.goal, familyRunId),
      status: "pending" as const,
      reason: null,
    }));
    const selected = (await sql<Array<{ attempt: number }>>`
      select attempt from public.case_runs
      where suite_run_id = ${job.suite_run_id}
        and snapshot_case_id = ${scopedSnapshotCaseId}
        and team_id = ${job.team_id}::uuid
        and status in ('queued', 'running')
      order by attempt desc limit 1
      for update
    `)[0]?.attempt;
    // A case retry preselects its Journey's attempt; the hook rows around
    // it are not preselected and number their own attempts like a suite run.
    const scopedAttempt = requestedAttempt ?? selected ?? (target.mode === "case_retry" && target.role === "journey"
      ? undefined
      : (await sql<Array<{ attempt: number }>>`
          select coalesce(max(attempt), 0)::integer + 1 as attempt
          from public.case_runs
          where snapshot_case_id = ${scopedSnapshotCaseId}
            and team_id = ${job.team_id}::uuid
        `)[0]?.attempt);
    if (!scopedAttempt) throw new Error("Preselected Case Retry is missing.");
    let rows = await sql<RunnerCaseRunRow[]>`
      update public.case_runs
      set status = 'running', started_at = coalesce(started_at, now()),
          role = ${target.role},
          checklist = ${sql.json(initialChecklist)}
      where suite_run_id = ${job.suite_run_id}
        and snapshot_case_id = ${scopedSnapshotCaseId}
        and team_id = ${job.team_id}::uuid
        and attempt = ${scopedAttempt}
        and status in ('queued', 'running')
      returning ${sql(CASE_RUN_ROW_COLUMNS)}
    `;
    if (!rows[0]) {
      // A case retry preselects one Journey; the hooks around it start fresh rows.
      if (target.mode === "case_retry" && target.role === "journey") {
        throw new Error("Case Retry Job can only start its preselected Case.");
      }
      rows = await sql<RunnerCaseRunRow[]>`
        insert into public.case_runs (
          id, suite_run_id, snapshot_case_id, team_id, position,
          attempt, status, role, checklist, started_at
        ) values (
          ${generatedTextId("case_run")}, ${job.suite_run_id}, ${scopedSnapshotCaseId},
          ${job.team_id}::uuid, ${target.position}, ${scopedAttempt}, 'running',
          ${target.role}, ${sql.json(initialChecklist)}, now()
        )
        returning ${sql(CASE_RUN_ROW_COLUMNS)}
      `;
    }
    return mapRunnerCaseRun(expectRow(rows, "case_runs", "insert"));
  });
}

/**
 * The tail every write to a live Case Run shares: only a queued, running or
 * waiting one takes the SET fragment, and the row it leaves is the answer.
 */
async function updateActiveCaseRun(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
  caseRunId: string,
  set: postgres.Fragment,
): Promise<RunnerCaseRun> {
  const rows = await sql<RunnerCaseRunRow[]>`
    update public.case_runs
    set ${set}
    where id = ${nonEmpty(caseRunId, "caseRunId")}
      and suite_run_id = ${job.suite_run_id}
      and team_id = ${job.team_id}::uuid
      and status in ('queued', 'running', 'waiting_for_auth')
    returning ${sql(CASE_RUN_ROW_COLUMNS)}
  `;
  if (!rows[0]) throw new Error("Active scoped Case Run not found.");
  return mapRunnerCaseRun(rows[0]);
}

export async function updateCaseChecklistForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  caseRunId: string,
  checklist: RunnerCaseRun["checklist"],
): Promise<RunnerCaseRun> {
  const normalized = normalizeChecklist(checklist, false);
  return sql.begin(async (sql) => {
    const job = await lockSuiteRunJob(sql, capability);
    await requireScopedCaseRun(sql, job, caseRunId);
    const currentRows = await sql<Array<{ checklist: RunnerCaseRun["checklist"] }>>`
      select checklist from public.case_runs
      where id = ${nonEmpty(caseRunId, "caseRunId")}
        and suite_run_id = ${job.suite_run_id}
        and team_id = ${job.team_id}::uuid
      for update
    `;
    const kept = checklistTransition(currentRows[0]?.checklist ?? [], normalized);
    return updateActiveCaseRun(sql, job, caseRunId, sql`checklist = ${sql.json(kept)}`);
  });
}

export async function updateCaseTrustForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  caseRunId: string,
  input: UpdateCaseTrustForJobInput,
): Promise<RunnerCaseRun> {
  return sql.begin(async (sql) => {
    const job = await lockSuiteRunJob(sql, capability);
    await requireScopedCaseRun(sql, job, caseRunId);
    return updateActiveCaseRun(sql, job, caseRunId, sql`
      reproduced_runs = ${input.reproducedRuns},
      code_evidence = ${input.codeEvidence
        ? sql.json(input.codeEvidence)
        : null}
    `);
  });
}

export async function completeCaseRunForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  caseRunId: string,
  input: CompleteCaseRunForJobInput,
): Promise<RunnerCaseRun> {
  // The terminal mode's one deliberate escape: a verdict that makes no
  // product claim (CHECKLISTLESS_VERDICTS) may end a Case that never got far
  // enough to report a checklist — e.g. an auth takeover canceled before any
  // checkpoint was observed. The stored checklist is then honestly empty; the
  // DB CHECK accepts the empty array on terminal rows.
  const checklistlessTerminal =
    input.checklist.length === 0 && CHECKLISTLESS_VERDICTS.has(input.verdict);
  const normalized = checklistlessTerminal ? [] : normalizeChecklist(input.checklist, true);
  const summary = nonEmpty(input.summary, "summary");
  if (summary.length > 8_000) throw new Error("summary exceeds 8000 characters.");
  const failureReason = input.failureReason?.trim() || null;
  return sql.begin(async (sql) => {
    const job = await lockSuiteRunJob(sql, capability);
    await requireScopedCaseRun(sql, job, caseRunId);
    const currentRows = await sql<Array<{ checklist: RunnerCaseRun["checklist"] }>>`
      select checklist from public.case_runs
      where id = ${nonEmpty(caseRunId, "caseRunId")}
        and suite_run_id = ${job.suite_run_id}
        and team_id = ${job.team_id}::uuid
      for update
    `;
    const kept = checklistlessTerminal ? [] : checklistTransition(currentRows[0]?.checklist ?? [], normalized);
    return updateActiveCaseRun(sql, job, caseRunId, sql`
      status = ${input.verdict === "canceled" ? "canceled" : "completed"},
      verdict = ${input.verdict}, summary = ${summary},
      failure_reason = ${failureReason},
      checklist = ${sql.json(kept)},
      walk_ms = ${input.walk?.walkMs ?? null},
      journey_case_id = ${input.walk?.journeyCaseId ?? null},
      completed_at = now()
    `);
  });
}
