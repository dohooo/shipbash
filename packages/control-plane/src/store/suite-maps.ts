/**
 * Row→domain mapping for the verification domain: Suites (Journeys), their
 * cases, definition revisions, Proposals, Runs, and Run schedules. Pure
 * projections — no queries, no clock, no policy.
 */
import { journeyEditInstructionsFromTrigger } from "../journey-edit.ts";
import { iso, journeyCheckpoints, journeySteps, storedPreconditions } from "./normalize.ts";
import type {
  OccurrenceRow,
  ProposalRow,
  RevisionRow,
  ScheduleRow,
  SuiteCaseRow,
  SuiteRow,
  SuiteRunRow,
} from "./rows.ts";
import type {
  DurableSuite,
  DurableSuiteCase,
  ScheduleOccurrence,
  SuiteDefinitionRevision,
  SuiteProposal,
  SuiteRunSummary,
  SuiteSchedule,
} from "../types.ts";

export function mapSuite(row: SuiteRow): DurableSuite {
  return {
    id: row.id,
    teamId: row.team_id,
    projectId: row.project_id,
    name: row.name,
    definitionRevision: row.definition_revision,
    lifecycleStatus: row.lifecycle_status,
    productThesis: row.product_thesis,
    createdBy: row.created_by,
    createdAt: iso(row.created_at, "suites.created_at"),
    updatedAt: iso(row.updated_at, "suites.updated_at"),
  };
}

export function mapSuiteCase(row: SuiteCaseRow): DurableSuiteCase {
  return {
    id: row.id,
    teamId: row.team_id,
    projectId: row.project_id,
    suiteId: row.suite_id,
    position: row.position,
    title: row.title,
    steps: journeySteps(row.steps),
    category: row.category,
    checkpoints: journeyCheckpoints(row.checkpoints),
    whyItMatters: row.why_it_matters,
    preconditions: storedPreconditions(row.preconditions),
    role: row.role,
    scopeCaseId: row.scope_case_id,
    repeat: row.repeat,
    enabled: row.enabled,
    archivedAt: iso(row.archived_at, "suite_cases.archived_at"),
    origin: row.origin,
    revision: row.revision,
    createdAt: iso(row.created_at, "suite_cases.created_at"),
    updatedAt: iso(row.updated_at, "suite_cases.updated_at"),
  };
}

export function mapRevision(row: RevisionRow): SuiteDefinitionRevision {
  return {
    id: row.id,
    teamId: row.team_id,
    projectId: row.project_id,
    suiteId: row.suite_id,
    revision: row.revision,
    definition: row.definition,
    source: row.source,
    sourceRef: row.source_ref,
    createdBy: row.created_by,
    createdAt: iso(row.created_at, "suite_definition_revisions.created_at"),
  };
}

// `trigger` is optional on purpose: only the selects that can see a
// journey-edit staging draft fetch it; everywhere else the field is
// truthfully null (no other trigger kind carries instructions).
export function mapProposal(row: ProposalRow & { trigger?: unknown; source_activity_id?: string | null; edit_walk_draft_id?: string | null }): SuiteProposal {
  return {
    id: row.id,
    sourceActivityId: row.source_activity_id ?? null,
    editWalkDraftId: row.edit_walk_draft_id ?? null,
    teamId: row.team_id,
    projectId: row.project_id,
    kind: row.kind,
    targetSuiteId: row.target_suite_id,
    appliedSuiteId: row.applied_suite_id,
    baseDefinitionRevision: row.base_definition_revision,
    proposedSuiteName: row.proposed_suite_name,
    productThesis: row.product_thesis,
    candidateDefinition: row.candidate_definition,
    status: row.status,
    repositoryCommitSha: row.repository_commit_sha,
    promptContractVersion: row.prompt_contract_version,
    journeyEditInstructions: journeyEditInstructionsFromTrigger(row.trigger),
    createdAt: iso(row.created_at, "proposals.created_at"),
    updatedAt: iso(row.updated_at, "proposals.updated_at"),
    decidedAt: iso(row.decided_at, "proposals.decided_at"),
  };
}

export function mapSuiteRun(row: SuiteRunRow): SuiteRunSummary {
  return {
    id: row.id,
    teamId: row.team_id,
    projectId: row.project_id,
    suiteId: row.suite_id,
    snapshotId: row.suite_snapshot_id,
    sourceSuiteRunId: row.source_suite_run_id,
    status: row.status,
    verdict: row.verdict,
    finalizationStatus: row.finalization_status,
    isPublic: row.is_public ?? false,
    triggerKind: row.trigger_kind,
    createdAt: iso(row.created_at, "suite_runs.created_at"),
    startedAt: iso(row.started_at, "suite_runs.started_at"),
    completedAt: iso(row.completed_at, "suite_runs.completed_at"),
  };
}

export function mapSchedule(row: ScheduleRow): SuiteSchedule {
  return {
    id: row.id,
    teamId: row.team_id,
    projectId: row.project_id,
    suiteId: row.suite_id,
    cadence: row.cadence,
    localTime: row.local_time,
    cronExpression: row.cron_expression,
    timezone: row.timezone,
    nextRunAt: iso(row.next_run_at, "suite_schedules.next_run_at"),
    lastDispatchedAt: iso(row.last_dispatched_at, "suite_schedules.last_dispatched_at"),
    lastSkippedAt: iso(row.last_skipped_at, "suite_schedules.last_skipped_at"),
    lastSkipReason: row.last_skip_reason,
    updatedAt: iso(row.updated_at, "suite_schedules.updated_at"),
  };
}

export function mapOccurrence(row: OccurrenceRow): ScheduleOccurrence {
  return {
    id: row.id,
    teamId: row.team_id,
    projectId: row.project_id,
    suiteId: row.suite_id,
    scheduleId: row.schedule_id,
    scheduledFor: iso(row.scheduled_for, "schedule_occurrences.scheduled_for"),
    outcome: row.outcome,
    suiteRunId: row.suite_run_id,
    reason: row.reason,
    createdAt: iso(row.created_at, "schedule_occurrences.created_at"),
  };
}
