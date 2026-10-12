/**
 * Suite run schedules: the per-Suite cadence rows the schedule tick drains.
 *
 * Upsert enforces the product invariant that an active cadence needs an
 * active Suite with at least one enabled Case. Dispatching due schedules
 * stays with the tenant store's dispatch facet — it composes the shared
 * run-dispatch transaction, so it is not part of this module.
 * Callers own authorization exactly as in the sibling store modules.
 */
import type postgres from "postgres";

import { assertCronExpression, nextCronOccurrence, nextDailyOccurrence } from "../schedule-cron.ts";
import type { ScheduleRow } from "./rows.ts";
import { iso, nonEmpty } from "./normalize.ts";
import { mapSchedule } from "./suite-maps.ts";
import type { SuiteSchedule } from "../types.ts";
import { expectRow } from "./expect-row.ts";

/**
 * A Suite Schedule's timing fields, resolved per cadence. The cadence decides
 * which of them exist at all — `daily` needs a local time and a timezone,
 * `cron` an expression and a timezone, `off` none — so each branch holds its
 * own values and none of them has to be asserted back into existence.
 */
export function resolveSuiteScheduleTiming(input: {
  cadence: SuiteSchedule["cadence"];
  localTime?: string | null;
  cronExpression?: string | null | undefined;
  timezone?: string | null;
}): {
  localTime: string | null;
  cronExpression: string | null;
  timezone: string | null;
  nextRunAt: string | null;
} {
  switch (input.cadence) {
    case "off":
      return { localTime: null, cronExpression: null, timezone: null, nextRunAt: null };
    case "daily": {
      const localTime = nonEmpty(input.localTime ?? "", "localTime");
      if (!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(localTime)) {
        throw new Error("localTime must use HH:MM or HH:MM:SS.");
      }
      const timezone = nonEmpty(input.timezone ?? "", "timezone");
      return {
        localTime,
        cronExpression: null,
        timezone,
        nextRunAt: nextDailyOccurrence(localTime, timezone, new Date()),
      };
    }
    case "cron": {
      const timezone = nonEmpty(input.timezone ?? "", "timezone");
      const cronExpression = assertCronExpression(
        nonEmpty(input.cronExpression ?? "", "cronExpression"),
        timezone,
      );
      return {
        localTime: null,
        cronExpression,
        timezone,
        nextRunAt: nextCronOccurrence(cronExpression, timezone, new Date()),
      };
    }
  }
}

export async function upsertSuiteSchedule(
  sql: postgres.TransactionSql,
  input: {
    teamId: string;
    projectId: string;
    suiteId: string;
    cadence: SuiteSchedule["cadence"];
    localTime: string | null;
    cronExpression: string | null;
    timezone: string | null;
    nextRunAt: string | null;
    updatedBy: string;
  },
): Promise<SuiteSchedule> {
  const suites = await sql`
    select 1 from public.suites
    where id = ${input.suiteId}::uuid
      and team_id = ${input.teamId}::uuid
      and project_id = ${input.projectId}
      and lifecycle_status = 'active'
  `;
  if (!suites[0]) throw new Error("Active Suite not found.");
  if (input.cadence !== "off") {
    const enabled = await sql<Array<{ count: number }>>`
      select count(*)::integer as count from public.suite_cases
      where suite_id = ${input.suiteId}::uuid
        and team_id = ${input.teamId}::uuid
        and enabled = true and archived_at is null
    `;
    if ((enabled[0]?.count ?? 0) < 1) throw new Error("An active Schedule requires an enabled Case.");
  }
  const rows = await sql<ScheduleRow[]>`
    insert into public.suite_schedules (
      team_id, project_id, suite_id, cadence, local_time,
      cron_expression, timezone, next_run_at, updated_by
    ) values (
      ${input.teamId}::uuid, ${input.projectId}, ${input.suiteId}::uuid,
      ${input.cadence}, ${input.localTime}, ${input.cronExpression}, ${input.timezone},
      ${input.nextRunAt}, ${input.updatedBy}::uuid
    )
    on conflict (suite_id) do update
    set cadence = excluded.cadence,
        local_time = excluded.local_time,
        cron_expression = excluded.cron_expression,
        timezone = excluded.timezone,
        next_run_at = excluded.next_run_at,
        updated_by = excluded.updated_by,
        updated_at = now()
    returning id, team_id, project_id, suite_id, cadence, local_time::text,
      cron_expression, timezone, next_run_at, last_dispatched_at,
      last_skipped_at, last_skip_reason, updated_at
  `;
  return mapSchedule(expectRow(rows, "suite_schedules", "insert"));
}

export async function listActiveSuiteSchedules(
  sql: postgres.Sql | postgres.TransactionSql,
): Promise<SuiteSchedule[]> {
  const rows = await sql<ScheduleRow[]>`
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
      and suite.lifecycle_status = 'active'
      and project.lifecycle_status = 'active'
    order by schedule.id
  `;
  return rows.map((row) => mapSchedule(row));
}

/** When a Suite runs on its own, as saved. */
export type SuiteScheduleTiming = Pick<SuiteSchedule, "cadence" | "localTime" | "cronExpression" | "timezone" | "nextRunAt">;

/** The Suite's schedule as a conversation's turn tells it; null when none was ever saved. */
export async function selectSuiteScheduleTiming(
  sql: postgres.Sql | postgres.TransactionSql,
  input: { teamId: string; suiteId: string },
): Promise<SuiteScheduleTiming | null> {
  const rows = await sql<Array<Pick<ScheduleRow, "cadence" | "local_time" | "cron_expression" | "timezone" | "next_run_at">>>`
    select cadence, local_time::text, cron_expression, timezone, next_run_at
    from public.suite_schedules
    where suite_id = ${nonEmpty(input.suiteId, "suiteId")}::uuid and team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    cadence: row.cadence,
    localTime: row.local_time,
    cronExpression: row.cron_expression,
    timezone: row.timezone,
    nextRunAt: iso(row.next_run_at, "suite_schedules.next_run_at"),
  };
}
