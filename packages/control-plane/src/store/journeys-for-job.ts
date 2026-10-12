/**
 * The project's Journeys as list_journeys reads them (agent-data/journeys.ts),
 * under a job's scope: the approved Suite's live Journeys and hooks, each
 * with its latest verdict, and the reviews that still wait for the owner's
 * decision. Unlike the history, they are read as they stand now: a draft
 * kept or discarded since the leg began is no longer waiting.
 */
import type postgres from "postgres";

import type { ActivityStatus, SuiteCaseDefinition } from "../types.ts";
import type { HistoryScope } from "./history-for-job.ts";
import { latestCaseRun } from "./latest-case-run.ts";
import { deliveredBy } from "./walk-deliveries.ts";
import type { Timestamp } from "./rows.ts";

/** The most approved Journeys and hooks one answer lists. */
export const APPROVED_LIMIT = 100;

export interface ApprovedJourneyRow {
  id: string;
  title: string;
  category: string;
  role: string;
  scope_case_id: string | null;
  repeat: string;
  /** The script and the reasons, read only for a full answer. */
  steps?: unknown;
  checkpoints?: unknown;
  preconditions?: unknown;
  why_it_matters?: string | null;
  latest_verdict: string | null;
  latest_run_at: Timestamp | null;
  latest_case_run_id: string | null;
  /** The run whose page shows that walk: a retried Journey's original run. */
  latest_page_run_id: string | null;
}

/**
 * The Suite the chat runs and list_journeys reads, as an id in SQL: the first
 * active one holding a live Journey (service/dispatch-activity-journeys.ts
 * pickSeedSuite). An edit is staged only to its Cases (agent-data/edit.ts).
 */
export function seedSuiteId(sql: postgres.Sql | postgres.TransactionSql, scope: { teamId: string; projectId: string }): postgres.Fragment {
  return sql`(
    select suite.id from public.suites suite
    where suite.team_id = ${scope.teamId}::uuid and suite.project_id = ${scope.projectId}
      and suite.lifecycle_status = 'active'
      and exists (
        select 1 from public.suite_cases live
        where live.suite_id = suite.id and live.role = 'journey' and live.enabled and live.archived_at is null
      )
    order by suite.created_at, suite.id limit 1
  )`;
}

/**
 * The live Journeys and hooks of the Suite the chat runs (seedSuiteId) in its
 * order, each with its latest walk as the console's Journeys read it
 * (latest-case-run.ts).
 */
export function approvedJourneys(sql: postgres.Sql, scope: HistoryScope, full: boolean): Promise<ApprovedJourneyRow[]> {
  const script = full
    ? sql`, suite_case.steps, suite_case.checkpoints, suite_case.preconditions, suite_case.why_it_matters`
    : sql``;
  return sql<ApprovedJourneyRow[]>`
    select suite_case.id, suite_case.title, suite_case.category, suite_case.role, suite_case.scope_case_id,
      suite_case.repeat ${script},
      latest.verdict as latest_verdict, latest.run_at as latest_run_at,
      latest.case_run_id as latest_case_run_id, latest.page_run_id as latest_page_run_id
    from public.suite_cases suite_case
    ${latestCaseRun(sql)}
    where suite_case.team_id = ${scope.teamId}::uuid and suite_case.project_id = ${scope.projectId}
      and suite_case.enabled and suite_case.archived_at is null
      and suite_case.suite_id = ${seedSuiteId(sql, scope)}
    order by suite_case.position, suite_case.id
    limit ${APPROVED_LIMIT + 1}
  `;
}

export interface PendingDraftsRow {
  proposal_id: string;
  status: string;
  trigger: unknown;
  target_suite_id: string | null;
  candidate_definition: SuiteCaseDefinition[];
  updated_at: Timestamp;
  /** The walk that delivered it; null for a review no walk left. */
  walk_id: string | null;
  walk_kind: string | null;
  walk_status: ActivityStatus | null;
  /** The walk's line as the chat named it when it started the walk; null for any other walk. */
  walk_title: string | null;
  /** The staging draft an edit walk delivered this for; such a review never waits on its own. */
  edit_walk_draft_id: string | null;
  /** Every review still waiting, however many were read. */
  waiting: number;
}

/** The most waiting reviews one answer reads, as many as the console's review list reads (normalize.ts normalizeLimit). */
export const PENDING_READ_LIMIT = 100;

/**
 * The reviews still waiting for the owner, newest first, at most
 * PENDING_READ_LIMIT of them, by the rule the console counts them by
 * (contracts draft-decision.ts awaitsDecision, which the caller applies to
 * these rows too): ready or a draft, neither a staging draft's edits nor
 * what an edit walk delivered for them, each with the walk that delivered it
 * (walk-deliveries.ts) and, when a chat started it, its title. The caller's
 * own list is left out: its Activity's deliveries, the ones of the Activity
 * it retries or follows up, and the review a follow-up of it revises.
 */
export function pendingDrafts(sql: postgres.Sql, scope: HistoryScope): Promise<PendingDraftsRow[]> {
  const caller = (column: string) => sql`(
    select ${sql(column)} from public.activities caller
    where caller.id = ${scope.activityId}::uuid and caller.team_id = ${scope.teamId}::uuid
  )`;
  const own = scope.activityId
    ? sql`and (source.id is null or (source.id <> ${scope.activityId}::uuid and source.id is distinct from ${caller("source_activity_id")}))
      and proposal.id is distinct from ${caller("source_proposal_id")}`
    : sql``;
  return sql<PendingDraftsRow[]>`
    select proposal.id as proposal_id, proposal.status, proposal.trigger, proposal.target_suite_id,
      proposal.candidate_definition, proposal.updated_at,
      source.id::text as walk_id, source.kind as walk_kind, source.status as walk_status, work.title as walk_title,
      staging.id::text as edit_walk_draft_id, (count(*) over ())::integer as waiting
    from public.proposals proposal
    left join public.activities source on ${deliveredBy(sql, "proposal", "source")}
    left join public.slack_thread_work work on work.walk_activity_id = source.id
    left join public.proposals staging
      on staging.id = source.source_proposal_id and staging.team_id = source.team_id
      and staging.trigger ->> 'kind' = 'journey_edit'
    where proposal.team_id = ${scope.teamId}::uuid and proposal.project_id = ${scope.projectId}
      and proposal.status in ('ready', 'draft')
      and not coalesce(proposal.trigger ->> 'kind' = 'journey_edit' and jsonb_typeof(proposal.trigger -> 'instructions') = 'object', false)
      and staging.id is null ${own}
    order by proposal.updated_at desc, proposal.id
    limit ${PENDING_READ_LIMIT}
  `;
}
