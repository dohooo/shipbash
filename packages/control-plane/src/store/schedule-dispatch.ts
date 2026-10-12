/**
 * Schedule-driven run dispatch: the due-schedule sweep (skip-locked, one
 * occurrence per schedule with a deterministic dispatch identity) and the
 * schedule-id path used by the queue tick, which resolves the Project runtime
 * for its model contract.
 */
import { createHash } from "node:crypto";

import type postgres from "postgres";

import { modelContractFor } from "@shipbash/contracts/model-contract";
import { iso, nonEmpty, timestamp } from "./normalize.ts";
import { normalizeDispatchScope } from "./run-dispatch.ts";
import type { DueSuiteScheduleDispatch, ScheduleRow } from "./rows.ts";
import { dispatchScheduledRunTransaction } from "./snapshot-dispatch.ts";
import type { DispatchIdentityInput, ScheduledDispatchResult } from "../types.ts";

export async function dispatchDueSuiteSchedules(
  sql: postgres.Sql,
  input: {
    dueAt: string;
    limit?: number;
    dispatch: Omit<DispatchIdentityInput, "idempotencyKey" | "identityHash">;
  },
  runQuota: boolean,
): Promise<DueSuiteScheduleDispatch[]> {
  const dueAt = timestamp(input.dueAt, "dueAt");
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Due Schedule limit must be between 1 and 100.");
  }
  const expiresAt = timestamp(input.dispatch.expiresAt, "dispatch.expiresAt");
  return await sql.begin(async (sql) => {
    await sql.unsafe("set local statement_timeout = '10s'");
    const schedules = await sql<ScheduleRow[]>`
      select schedule.id, schedule.team_id, schedule.project_id, schedule.suite_id,
        schedule.cadence, schedule.local_time::text, schedule.cron_expression,
        schedule.timezone, schedule.next_run_at, schedule.last_dispatched_at, schedule.last_skipped_at,
        schedule.last_skip_reason, schedule.updated_at
      from public.suite_schedules schedule
      join public.suites suite
        on suite.id = schedule.suite_id and suite.team_id = schedule.team_id
      join public.projects project
        on project.id = schedule.project_id and project.team_id = schedule.team_id
      where schedule.cadence in ('daily', 'cron')
        and schedule.next_run_at <= ${dueAt}
        and suite.lifecycle_status = 'active'
        and project.lifecycle_status = 'active'
      order by schedule.next_run_at, schedule.id
      limit ${limit}
      for update of schedule skip locked
    `;
    const dispatched: DueSuiteScheduleDispatch[] = [];
    for (const schedule of schedules) {
      const scheduledFor = iso(
        schedule.next_run_at,
        "suite_schedules.next_run_at",
      );
      if (!scheduledFor) continue;
      const identityHash = createHash("sha256")
        .update(`production-schedule\0${schedule.id}\0${scheduledFor}`, "utf8")
        .digest("hex");
      const scope = normalizeDispatchScope(schedule.team_id, schedule.project_id, {
        ...input.dispatch,
        expiresAt,
        identityHash,
        idempotencyKey: `schedule:${schedule.id}:${scheduledFor}`,
      }, runQuota);
      dispatched.push({
        scheduleId: schedule.id,
        scheduledFor,
        result: await dispatchScheduledRunTransaction(sql, schedule, scheduledFor, scope),
      });
    }
    return dispatched;
  });
}

export async function dispatchScheduledRunBySchedule(
  sql: postgres.Sql,
  scheduleId: string,
  scheduledFor: string,
  dispatch: Omit<DispatchIdentityInput, "idempotencyKey">,
  sourceJobId: string | null,
  runQuota: boolean,
): Promise<ScheduledDispatchResult> {
  const scopedScheduleId = nonEmpty(scheduleId, "scheduleId");
  const occurrenceTime = timestamp(scheduledFor, "scheduledFor");
  return await sql.begin(async (sql) => {
    await sql.unsafe("set local statement_timeout = '10s'");
    const scheduleRows = await sql<ScheduleRow[]>`
      select id, team_id, project_id, suite_id, cadence, local_time::text,
        cron_expression, timezone, next_run_at, last_dispatched_at,
        last_skipped_at, last_skip_reason, updated_at
      from public.suite_schedules
      where id = ${scopedScheduleId}::uuid
      for update
    `;
    const schedule = scheduleRows[0];
    if (!schedule) throw new Error("Suite Schedule not found.");
    const scope = normalizeDispatchScope(schedule.team_id, schedule.project_id, {
      ...dispatch,
      modelContract: modelContractFor("verification"),
      idempotencyKey: `schedule:${scopedScheduleId}:${sourceJobId ?? occurrenceTime}`,
    }, runQuota);
    return dispatchScheduledRunTransaction(sql, schedule, occurrenceTime, scope, sourceJobId);
  });
}
