/**
 * The Suite definition save transaction: optimistic-revision compare, case
 * upsert with content-revision accounting, omitted-case archival, and the
 * immutable suite_definition_revisions projection — one write path shared by
 * manual saves and proposal application. Callers own authorization and the
 * transaction (tenant-store facade).
 */
import { randomUUID } from "node:crypto";

import type postgres from "postgres";

import { journeyCheckpoints, journeySteps, jsonValue, nonEmpty } from "./normalize.ts";
import {
  type RevisionRow,
  type SaveSuiteDefinitionArguments,
  SUITE_CASE_ROW_COLUMNS,
  SUITE_ROW_COLUMNS,
  type SuiteCaseRow,
  type SuiteRow,
} from "./rows.ts";
import { archiveOrphanedHooks, assertHookScopes, casesInWriteOrder } from "./suite-definition-save-hooks.ts";
import { RevisionConflictError } from "./revision-conflict.ts";
import { mapRevision, mapSuite, mapSuiteCase } from "./suite-maps.ts";
import type { SuiteDefinitionSaveResult, TenantActor } from "../types.ts";
import { expectRow } from "./expect-row.ts";

/**
 * Validates the write inputs and loads the target Suite `for update`, holding
 * the row so the optimistic-revision compare cannot race a concurrent save.
 * Returns the normalized Suite name for the closing update.
 */
async function loadSuiteForRevision(
  sql: postgres.TransactionSql,
  input: SaveSuiteDefinitionArguments,
): Promise<string> {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error("expectedRevision must be a non-negative integer.");
  }
  const name = nonEmpty(input.name, "name");
  if (name.length > 200) throw new Error("name exceeds 200 characters.");
  const suiteRows = await sql<SuiteRow[]>`
    select ${sql(SUITE_ROW_COLUMNS)}
    from public.suites
    where id = ${input.suiteId}::uuid
      and team_id = ${input.teamId}::uuid
      and project_id = ${input.projectId}
    for update
  `;
  const suite = suiteRows[0];
  if (!suite) throw new Error("Suite not found.");
  if (suite.definition_revision !== input.expectedRevision) {
    throw new RevisionConflictError(input.expectedRevision, suite.definition_revision);
  }
  return name;
}

/**
 * Rejects a Case id owned by another Suite in the same team, then shifts every
 * current position out of the way so the upsert can reassign 0..n-1 without
 * colliding on the per-Suite position. Returns the incoming Case ids.
 */
async function reserveExistingCasePositions(
  sql: postgres.TransactionSql,
  input: SaveSuiteDefinitionArguments,
): Promise<string[]> {
  const caseIds = input.cases.map((suiteCase) => suiteCase.id);
  const conflicts = caseIds.length === 0
    ? []
    : await sql<Array<{ id: string; suite_id: string }>>`
        select id, suite_id from public.suite_cases
        where id = any(${sql.array(caseIds)}::uuid[])
          and team_id = ${input.teamId}::uuid and suite_id <> ${input.suiteId}::uuid
        for update
      `;
  if (conflicts[0]) throw new Error(`Case ${conflicts[0].id} belongs to another Suite.`);

  await sql`
    update public.suite_cases
    set position = position + 1000000
    where suite_id = ${input.suiteId}::uuid and team_id = ${input.teamId}::uuid
  `;
  return caseIds;
}

/** Upserts each incoming Case at its ordinal position (0..n-1); scoped hooks after their Journeys. */
async function upsertSuiteCases(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  input: SaveSuiteDefinitionArguments,
): Promise<void> {
  for (const [position, suiteCase] of casesInWriteOrder(input.cases)) {
    const existing = await sql<Array<{ id: string }>>`
      select id from public.suite_cases
      where id = ${suiteCase.id}::uuid
        and suite_id = ${input.suiteId}::uuid
        and team_id = ${input.teamId}::uuid
      for update
    `;
    if (existing[0]) {
      await sql`
        update public.suite_cases
        set position = ${position}, title = ${suiteCase.title},
            steps = ${sql.json(jsonValue(suiteCase.steps))},
            category = ${suiteCase.category},
            checkpoints = ${sql.json(jsonValue(suiteCase.checkpoints))},
            why_it_matters = ${suiteCase.whyItMatters},
            preconditions = ${sql.json(jsonValue(suiteCase.preconditions))},
            role = ${suiteCase.role}, scope_case_id = ${suiteCase.scopeCaseId}::uuid,
            repeat = ${suiteCase.repeat},
            enabled = ${suiteCase.archived ? false : suiteCase.enabled},
            archived_at = case when ${suiteCase.archived} then coalesce(archived_at, now()) else null end,
            -- The revision is a content revision: an untouched script must
            -- not read as "unverified" just because the suite was saved.
            revision = revision + (case when
              title is distinct from ${suiteCase.title}
              or steps is distinct from ${sql.json(jsonValue(suiteCase.steps))}::jsonb
              or category is distinct from ${suiteCase.category}
              or checkpoints is distinct from ${sql.json(jsonValue(suiteCase.checkpoints))}::jsonb
              or why_it_matters is distinct from ${suiteCase.whyItMatters}
              or preconditions is distinct from ${sql.json(jsonValue(suiteCase.preconditions))}::jsonb
              or role is distinct from ${suiteCase.role}
              or scope_case_id is distinct from ${suiteCase.scopeCaseId}::uuid
              or repeat is distinct from ${suiteCase.repeat}
            then 1 else 0 end),
            updated_at = now()
        where id = ${suiteCase.id}::uuid
          and suite_id = ${input.suiteId}::uuid
          and team_id = ${input.teamId}::uuid
      `;
    } else {
      await sql`
        insert into public.suite_cases (
          id, team_id, project_id, suite_id, position, title, steps,
          category, checkpoints, why_it_matters, preconditions,
          role, scope_case_id, repeat,
          enabled, archived_at, origin, revision, created_by
        ) values (
          ${suiteCase.id}::uuid, ${input.teamId}::uuid, ${input.projectId},
          ${input.suiteId}::uuid, ${position}, ${suiteCase.title},
          ${sql.json(jsonValue(suiteCase.steps))},
          ${suiteCase.category}, ${sql.json(jsonValue(suiteCase.checkpoints))},
          ${suiteCase.whyItMatters},
          ${sql.json(jsonValue(suiteCase.preconditions))},
          ${suiteCase.role}, ${suiteCase.scopeCaseId}::uuid, ${suiteCase.repeat},
          ${suiteCase.archived ? false : suiteCase.enabled},
          ${suiteCase.archived ? new Date() : null},
          ${input.source === "manual" ? "manual" : input.source === "initial_confirmation" ? "initial_discovery" : "agent"},
          1, ${actor.userId}::uuid
        )
      `;
    }
  }
}

/**
 * Archives the Cases that dropped out of this save: they are packed after the
 * kept Cases, disabled, stamped archived_at, and given a revision bump so the
 * removal itself reads as a content change.
 */
async function archiveOmittedCases(
  sql: postgres.TransactionSql,
  input: SaveSuiteDefinitionArguments,
  caseIds: string[],
): Promise<void> {
  await sql`
    with omitted as (
      select id, ${input.cases.length} + row_number() over (order by position, id) - 1 as next_position
      from public.suite_cases
      where suite_id = ${input.suiteId}::uuid
        and team_id = ${input.teamId}::uuid
        and not (id = any(${sql.array(caseIds)}::uuid[]))
    )
    update public.suite_cases suite_case
    set position = omitted.next_position, enabled = false,
        archived_at = coalesce(suite_case.archived_at, now()),
        revision = suite_case.revision + 1, updated_at = now()
    from omitted where suite_case.id = omitted.id
  `;
}

/**
 * Reads back the final Case set, records the immutable definition revision,
 * bumps the Suite to the next revision, and assembles the save result.
 */
async function projectAndCommitRevision(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  input: SaveSuiteDefinitionArguments,
  name: string,
): Promise<SuiteDefinitionSaveResult> {
  const projectedCases = await sql<SuiteCaseRow[]>`
    select ${sql(SUITE_CASE_ROW_COLUMNS)}
    from public.suite_cases
    where suite_id = ${input.suiteId}::uuid and team_id = ${input.teamId}::uuid
    order by position, id
  `;
  const definition = projectedCases.map((row) => ({
    id: row.id,
    title: row.title,
    steps: journeySteps(row.steps),
    category: row.category,
    checkpoints: journeyCheckpoints(row.checkpoints),
    whyItMatters: row.why_it_matters,
    // The history says what the Case was: a hook, its Journey, its repeat.
    role: row.role,
    scopeCaseId: row.scope_case_id,
    repeat: row.repeat,
    enabled: row.enabled,
    archived: row.archived_at !== null,
    position: row.position,
    revision: row.revision,
  }));
  const nextRevision = input.expectedRevision + 1;
  const revisionId = randomUUID();
  const revisionRows = await sql<RevisionRow[]>`
    insert into public.suite_definition_revisions (
      id, team_id, project_id, suite_id, revision, definition,
      source, source_ref, created_by
    ) values (
      ${revisionId}, ${input.teamId}::uuid, ${input.projectId}, ${input.suiteId}::uuid,
      ${nextRevision}, ${sql.json(jsonValue(definition))},
      ${input.source}, ${input.sourceRef}, ${actor.userId}::uuid
    )
    returning id, team_id, project_id, suite_id, revision, definition,
      source, source_ref, created_by, created_at
  `;
  const updatedSuites = await sql<SuiteRow[]>`
    update public.suites
    set name = ${name}, definition_revision = ${nextRevision}, updated_at = now()
    where id = ${input.suiteId}::uuid and team_id = ${input.teamId}::uuid
    returning ${sql(SUITE_ROW_COLUMNS)}
  `;
  return {
    suite: mapSuite(expectRow(updatedSuites, "suites", "update")),
    revision: mapRevision(expectRow(revisionRows, "suite_definition_revisions", "insert")),
    cases: projectedCases.map((row) => mapSuiteCase(row)),
  };
}

export async function saveSuiteDefinitionTransaction(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  input: SaveSuiteDefinitionArguments,
): Promise<SuiteDefinitionSaveResult> {
  assertHookScopes(input.cases);
  const name = await loadSuiteForRevision(sql, input);
  const caseIds = await reserveExistingCasePositions(sql, input);
  await upsertSuiteCases(sql, actor, input);
  await archiveOmittedCases(sql, input, caseIds);
  await archiveOrphanedHooks(sql, input);
  return projectAndCommitRevision(sql, actor, input, name);
}

/**
 * The team-scoped conflict guard above cannot see rows outside the caller's
 * team, so a foreign case id lands on the primary key instead; surface that
 * as a conflict without echoing the raw constraint name.
 */
export async function saveSuiteDefinitionGuarded(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  input: SaveSuiteDefinitionArguments,
): Promise<SuiteDefinitionSaveResult> {
  try {
    return await saveSuiteDefinitionTransaction(sql, actor, input);
  } catch (error) {
    if (
      error instanceof Error &&
      Reflect.get(error, "code") === "23505" &&
      Reflect.get(error, "constraint_name") === "suite_cases_pkey"
    ) {
      throw new Error("A Case id in this save conflicts with a Case owned elsewhere.");
    }
    throw error;
  }
}
