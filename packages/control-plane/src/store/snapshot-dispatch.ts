/**
 * Snapshot-cutting dispatch: freezing the current Suite definition, auth
 * profile, repository pin, and testing context into a suite_snapshot and dispatching the Run from it — plus the scheduled-run
 * variant that records its schedule occurrence (or why it was skipped) and
 * advances next_run_at, and
 * the verification of what a keep landed, which may walk some Journeys only.
 * Callers own authorization and the transaction (tenant-store facade).
 */
import type postgres from "postgres";

import { ensureRunAuthProfileRow, type RunAuthProfileRow } from "./auth-profiles.ts";
import {
  generatedTextId,
  journeyCheckpoints,
  journeySteps,
  jsonValue,
  safeJsonObject,
  storedPreconditions,
  timestamp,
} from "./normalize.ts";
import {
  createRunFromSnapshotTransaction,
  findDispatchByKey,
  findOutstandingRun,
} from "./run-dispatch.ts";
import {
  type NormalizedDispatchScope,
  type OccurrenceRow,
  type ProjectRow,
  type RevisionRow,
  type ScheduleRow,
  SUITE_CASE_ROW_COLUMNS,
  SUITE_ROW_COLUMNS,
  type SuiteCaseRow,
  type SuiteRow,
} from "./rows.ts";
import { VerificationInProgressError } from "./proposal-conflict.ts";
import { RunQuotaExceededError } from "./run-quota.ts";
import { casesForJourneys, casesWalkedEveryRun } from "./snapshot-cases.ts";
import { mapOccurrence } from "./suite-maps.ts";
import { nextCronOccurrence, nextDailyOccurrence } from "../schedule-cron.ts";
import type { RunDispatchResult, ScheduledDispatchResult } from "../types.ts";
import { expectRow } from "./expect-row.ts";

/** The next window for a schedule, computed from now for cron so a slept-through
 * backlog collapses into the one run just dispatched rather than replaying. */
function computeScheduleNextRunAt(
  schedule: ScheduleRow,
  occurrenceTime: string,
): string | null {
  if (schedule.cadence === "daily" && schedule.local_time && schedule.timezone) {
    return nextDailyOccurrence(schedule.local_time, schedule.timezone, new Date(occurrenceTime));
  }
  if (schedule.cadence === "cron" && schedule.cron_expression && schedule.timezone) {
    return nextCronOccurrence(
      schedule.cron_expression,
      schedule.timezone,
      new Date(Math.max(new Date(occurrenceTime).valueOf(), Date.now())),
    );
  }
  return null;
}

/**
 * The run a schedule's occurrence starts, or why it starts none: the
 * schedule is off, a run of the Suite is still under way, or the team has
 * used this month's Runs (run-quota.ts). The dispatch runs in a savepoint,
 * so a run the allowance refuses leaves no snapshot behind.
 */
async function occurrenceDispatch(
  sql: postgres.TransactionSql,
  schedule: ScheduleRow,
  occurrenceTime: string,
  scope: NormalizedDispatchScope,
): Promise<{ runDispatch: RunDispatchResult | null; skipReason: string | null }> {
  if (schedule.cadence === "off") return { runDispatch: null, skipReason: "schedule_off" };
  try {
    const runDispatch = await sql.savepoint((savepoint) => createCurrentSnapshotDispatchTransaction(savepoint, {
      ...scope,
      suiteId: schedule.suite_id,
      triggerKind: "scheduled",
      triggerIdentity: { kind: "scheduled", scheduleId: schedule.id, scheduledFor: occurrenceTime },
      scheduledFor: occurrenceTime,
    }));
    return runDispatch.reusedOutstanding
      ? { runDispatch: null, skipReason: "suite_run_already_outstanding" }
      : { runDispatch, skipReason: null };
  } catch (error) {
    if (error instanceof RunQuotaExceededError) return { runDispatch: null, skipReason: "run_quota_exceeded" };
    throw error;
  }
}

export async function dispatchScheduledRunTransaction(
  sql: postgres.TransactionSql,
  schedule: ScheduleRow,
  occurrenceTime: string,
  scope: NormalizedDispatchScope,
  sourceJobId: string | null = null,
): Promise<ScheduledDispatchResult> {
  if (schedule.team_id !== scope.teamId || schedule.project_id !== scope.projectId) {
    throw new Error("Suite Schedule scope does not match dispatch scope.");
  }
  const nextRunAt = computeScheduleNextRunAt(schedule, occurrenceTime);
  const existingRows = await sql<OccurrenceRow[]>`
    select id, team_id, project_id, suite_id, schedule_id, scheduled_for,
      outcome, suite_run_id, reason, created_at
    from public.schedule_occurrences
    where (schedule_id = ${schedule.id}::uuid and scheduled_for = ${occurrenceTime})
       or (${sourceJobId}::uuid is not null and source_job_id = ${sourceJobId}::uuid)
    order by created_at
    limit 1
  `;
  if (existingRows[0]) {
    const occurrence = mapOccurrence(existingRows[0]);
    const existingDispatch = occurrence.suiteRunId
      ? await findDispatchByKey(sql, scope.teamId, scope.idempotencyKey)
      : null;
    return { occurrence, dispatch: existingDispatch, created: false };
  }

  const { runDispatch, skipReason } = await occurrenceDispatch(sql, schedule, occurrenceTime, scope);
  const occurrenceRows = await sql<OccurrenceRow[]>`
    insert into public.schedule_occurrences (
      team_id, project_id, suite_id, schedule_id, source_job_id, scheduled_for,
      outcome, suite_run_id, reason
    ) values (
      ${scope.teamId}::uuid, ${scope.projectId}, ${schedule.suite_id}::uuid,
      ${schedule.id}::uuid, ${sourceJobId}::uuid, ${occurrenceTime},
      ${skipReason ? "skipped" : "dispatched"}, ${runDispatch?.run.id ?? null}, ${skipReason}
    )
    returning id, team_id, project_id, suite_id, schedule_id,
      scheduled_for, outcome, suite_run_id, reason, created_at
  `;
  await sql`
    update public.suite_schedules
    set last_dispatched_at = case when ${skipReason}::text is null then ${occurrenceTime}::timestamptz else last_dispatched_at end,
        last_skipped_at = case when ${skipReason}::text is not null then ${occurrenceTime}::timestamptz else last_skipped_at end,
        last_skip_reason = ${skipReason},
        next_run_at = ${nextRunAt ? timestamp(nextRunAt, "nextRunAt") : null},
        updated_at = now()
    where id = ${schedule.id}::uuid
      and team_id = ${scope.teamId}::uuid
      and project_id = ${scope.projectId}
  `;
  return {
    occurrence: mapOccurrence(expectRow(occurrenceRows, "schedule_occurrences", "insert")),
    dispatch: runDispatch,
    created: true,
  };
}

/** What the snapshot reads of its Project. */
type SnapshotProjectRow = Pick<ProjectRow, "production_url" | "testing_context"> & {
  repository_id: string | null;
  selected_commit_sha: string | null;
};

type SnapshotDispatchInput = NormalizedDispatchScope & {
  suiteId: string;
  triggerKind: "initial_confirmation" | "manual" | "scheduled";
  triggerIdentity: Record<string, unknown>;
  scheduledFor?: string | null;
};

const isJourney = (row: { role: string }) => row.role === "journey";

/** The active Suite, locked for the dispatch; or the run this dispatch identity already started. */
async function lockSuite(
  sql: postgres.TransactionSql,
  input: SnapshotDispatchInput,
): Promise<{ dispatched: RunDispatchResult } | { dispatched: null; suite: SuiteRow }> {
  const existing = await findDispatchByKey(sql, input.teamId, input.idempotencyKey);
  if (existing) return { dispatched: existing };
  const suiteRows = await sql<SuiteRow[]>`
    select ${sql(SUITE_ROW_COLUMNS)}
    from public.suites
    where id = ${input.suiteId}::uuid
      and team_id = ${input.teamId}::uuid
      and project_id = ${input.projectId}
    for update
  `;
  const suite = suiteRows[0];
  if (suite?.lifecycle_status !== "active") throw new Error("Active Suite not found.");
  const afterLock = await findDispatchByKey(sql, input.teamId, input.idempotencyKey);
  return afterLock ? { dispatched: afterLock } : { dispatched: null, suite };
}

/** The live Cases a run of the Suite walks (snapshot-cases.ts), in Suite order. */
async function walkedCases(sql: postgres.TransactionSql, input: SnapshotDispatchInput): Promise<SuiteCaseRow[]> {
  const liveRows = await sql<SuiteCaseRow[]>`
    select ${sql(SUITE_CASE_ROW_COLUMNS)}
    from public.suite_cases
    where suite_id = ${input.suiteId}::uuid
      and team_id = ${input.teamId}::uuid
      and enabled = true and archived_at is null
    order by position, id
  `;
  return casesWalkedEveryRun(liveRows);
}

export async function createCurrentSnapshotDispatchTransaction(
  sql: postgres.TransactionSql,
  input: SnapshotDispatchInput,
): Promise<RunDispatchResult> {
  const locked = await lockSuite(sql, input);
  if (locked.dispatched) return locked.dispatched;
  const outstanding = await findOutstandingRun(sql, input.teamId, input.suiteId);
  if (outstanding) return outstanding;
  const caseRows = await walkedCases(sql, input);
  if (!caseRows.some(isJourney)) {
    throw new Error("A Run requires at least one enabled Journey that is walked on every run.");
  }
  return dispatchSnapshot(sql, input, locked.suite, caseRows);
}

/**
 * The verification of what a keep landed: a run of the named Journeys with
 * the hooks they walk with, or of the whole Suite when none are named; null
 * when a run walks none of them. A Suite runs one at a time, so a run of it
 * under way answers only when its snapshot walks these very Cases as they
 * are now; any other refuses the verification.
 */
export async function dispatchVerificationTransaction(
  sql: postgres.TransactionSql,
  input: SnapshotDispatchInput & { journeyIds?: readonly string[] | undefined },
): Promise<RunDispatchResult | null> {
  const locked = await lockSuite(sql, input);
  if (locked.dispatched) return locked.dispatched;
  const walked = await walkedCases(sql, input);
  const caseRows = input.journeyIds ? casesForJourneys(walked, input.journeyIds) : walked;
  if (!caseRows.some(isJourney)) return null;
  const outstanding = await findOutstandingRun(sql, input.teamId, input.suiteId);
  if (!outstanding) return dispatchSnapshot(sql, input, locked.suite, caseRows);
  if (await walksExactly(sql, input.teamId, outstanding.snapshotId, caseRows)) return outstanding;
  throw new VerificationInProgressError(outstanding.run.id);
}

/**
 * Whether a snapshot walks these Cases at their current revisions: the same
 * Journeys, and no hook beside them that the Suite no longer walks with them.
 */
async function walksExactly(
  sql: postgres.TransactionSql,
  teamId: string,
  snapshotId: string,
  caseRows: readonly SuiteCaseRow[],
): Promise<boolean> {
  const held = await sql<Array<{ id: string; role: string; scope_case_id: string | null; revision: number }>>`
    select suite_case_id as id, role, scope_suite_case_id as scope_case_id, suite_case_revision as revision
    from public.suite_snapshot_cases
    where snapshot_id = ${snapshotId} and team_id = ${teamId}::uuid
  `;
  const key = (rows: ReadonlyArray<{ id: string; revision: number }>) =>
    rows.map((row) => `${row.id}@${String(row.revision)}`).sort().join();
  return key(casesForJourneys(held, caseRows.filter(isJourney).map((row) => row.id))) === key(caseRows);
}

/** Freezes these Cases with the Suite's current definition and the Project into a snapshot, and dispatches the Run from it. */
async function dispatchSnapshot(
  sql: postgres.TransactionSql,
  input: SnapshotDispatchInput,
  suite: SuiteRow,
  caseRows: SuiteCaseRow[],
): Promise<RunDispatchResult> {
  const revisions = await sql<RevisionRow[]>`
    select id, team_id, project_id, suite_id, revision, definition,
      source, source_ref, created_by, created_at
    from public.suite_definition_revisions
    where suite_id = ${input.suiteId}::uuid
      and team_id = ${input.teamId}::uuid
      and revision = ${suite.definition_revision}
  `;
  if (!revisions[0]) throw new Error("Current Suite definition revision is missing.");
  const projects = await sql<SnapshotProjectRow[]>`
    select project.id, project.team_id, project.slug, project.name, project.production_url,
      project.testing_context, project.lifecycle_status,
      project.created_at, project.updated_at,
      -- A run carries the binding's last read only while it is readable.
      case when repository.access_status = 'ready' and repository.selected_commit_sha is not null
        then repository.id end as repository_id,
      case when repository.access_status = 'ready' then repository.selected_commit_sha end as selected_commit_sha
    from public.projects project
    left join public.project_repositories repository
      on repository.project_id = project.id and repository.team_id = project.team_id
    where project.id = ${input.projectId} and project.team_id = ${input.teamId}::uuid
    for share of project
  `;
  const project = projects[0];
  if (!project?.production_url) throw new Error("Project Production URL is missing.");
  const authProfile = await ensureRunAuthProfileRow(sql, {
    teamId: input.teamId,
    projectId: input.projectId,
    productionOrigin: new URL(project.production_url).origin,
    locator: `runner-workspace:${input.projectId}:target-auth:default`,
  });
  const snapshotId = generatedTextId("suite_snapshot");
  await insertSuiteSnapshotRows(sql, {
    snapshotId,
    input,
    revision: revisions[0],
    project,
    authProfile,
    // The owner's own words, frozen with the run; the knowledge beside them
    // is read when the run is prepared (knowledge-context.ts loadRunKnowledge).
    testingContext: project.testing_context,
    caseRows,
  });
  return createRunFromSnapshotTransaction(sql, {
    ...input,
    snapshotId,
    sourceSuiteRunId: null,
    mode: "suite",
    scheduledFor: input.scheduledFor ?? null,
  }, true);
}

/** Materializes the frozen snapshot rows (header, per-case) inside the
 * caller's transaction. */
async function insertSuiteSnapshotRows(
  sql: postgres.TransactionSql,
  args: {
    snapshotId: string;
    input: SnapshotDispatchInput;
    revision: RevisionRow;
    project: SnapshotProjectRow;
    authProfile: RunAuthProfileRow;
    testingContext: string | null;
    caseRows: SuiteCaseRow[];
  },
): Promise<void> {
  const { snapshotId, input, revision, project, authProfile, testingContext, caseRows } = args;
  await sql`
    insert into public.suite_snapshots (
      id, project_id, team_id, production_url, suite_id, definition_revision_id,
      auth_profile_id, auth_profile_state_version, repository_id,
      repository_commit_sha, testing_context, prompt_contract_versions,
      model_contract, trigger_identity
    ) values (
      ${snapshotId}, ${input.projectId}, ${input.teamId}::uuid,
      ${project.production_url}, ${input.suiteId}::uuid, ${revision.id}::uuid,
      ${authProfile.id}, ${authProfile.state_version},
      ${project.repository_id}::uuid, ${project.selected_commit_sha}, ${testingContext},
      ${sql.json(safeJsonObject(input.promptContractVersions, "promptContractVersions"))},
      ${sql.json(safeJsonObject(input.modelContract, "modelContract"))},
      ${sql.json(safeJsonObject(input.triggerIdentity, "triggerIdentity"))}
    )
  `;
  for (const suiteCase of caseRows) {
    await sql`
      insert into public.suite_snapshot_cases (
        id, snapshot_id, team_id, suite_case_id,
        suite_case_revision, position, title, step_list, category, checkpoints,
        preconditions, role, scope_suite_case_id, repeat
      ) values (
        ${generatedTextId("snapshot_case")}, ${snapshotId}, ${input.teamId}::uuid,
        ${suiteCase.id}::uuid, ${suiteCase.revision}, ${suiteCase.position},
        ${suiteCase.title}, ${sql.json(jsonValue(journeySteps(suiteCase.steps)))}, ${suiteCase.category},
        ${sql.json(jsonValue(journeyCheckpoints(suiteCase.checkpoints)))},
        ${sql.json(jsonValue(storedPreconditions(suiteCase.preconditions)))},
        ${suiteCase.role}, ${suiteCase.scope_case_id}::uuid, ${suiteCase.repeat}
      )
    `;
  }
}
