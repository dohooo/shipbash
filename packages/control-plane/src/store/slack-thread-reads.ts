/**
 * What a conversation's thread is told, read for its turns and the bot: the
 * drafts a walk's report names and decide_drafts decides on, what an edit
 * walk proved of the edits decide_edits decides on, and the run a thread
 * hangs under when its root is a ShipBash alert.
 *
 * Authorization-blind, like their neighbours: every statement is bound to the
 * team the thread or the binding names.
 */
import type postgres from "postgres";

import { validateCaseRepeat, validateCaseRole } from "@shipbash/contracts/runtime/case-role-contract.mjs";

import type { ReviewProposal } from "../journey-edit-review.ts";
import type { SuiteCaseDefinition } from "../types.ts";
import type { JourneyDefinition } from "./journey-equivalence.ts";
import { walkFinal } from "./journey-edit-keep.ts";
import { readStagingDraft } from "./journey-edit-staging.ts";
import { journeyCheckpoints, journeySteps, nonEmpty } from "./normalize.ts";
import { deliveredBy } from "./walk-deliveries.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** A live Case of a Suite, as a review decides on the drafts that change it. */
export type LiveCase = JourneyDefinition & { id: string };

/** A delivered proposal's drafts, as a walk's report names them and decide_drafts decides on them, with the live Cases of the Suite it changes. */
export interface ProposalDrafts {
  candidateDefinition: SuiteCaseDefinition[];
  liveCases: LiveCase[];
  /** Delivered by a Discovery, whose list carries the Suite's live Cases as they are (draft-review.ts). */
  discovery: boolean;
}

/** The live Cases of these Suites, by Suite. */
export async function selectSuiteCases(
  sql: Queryable,
  input: { teamId: string; projectId: string; suiteIds: readonly string[] },
): Promise<Map<string, LiveCase[]>> {
  const bySuite = new Map<string, LiveCase[]>();
  if (input.suiteIds.length === 0) return bySuite;
  const rows = await sql<Array<{
    id: string; suite_id: string; title: string; category: string; why_it_matters: string | null; steps: unknown; checkpoints: unknown;
    role: string; scope_case_id: string | null; repeat: string;
  }>>`
    select id, suite_id, title, category, why_it_matters, steps, checkpoints, role, scope_case_id, repeat
    from public.suite_cases
    where suite_id = any(${sql.array([...input.suiteIds])}::uuid[])
      and team_id = ${nonEmpty(input.teamId, "teamId")}::uuid and project_id = ${nonEmpty(input.projectId, "projectId")}
      and archived_at is null
  `;
  for (const row of rows) {
    bySuite.set(row.suite_id, [...bySuite.get(row.suite_id) ?? [], {
      id: row.id,
      title: row.title,
      category: row.category,
      whyItMatters: row.why_it_matters,
      steps: journeySteps(row.steps),
      checkpoints: journeyCheckpoints(row.checkpoints),
      role: row.role,
      scopeCaseId: row.scope_case_id,
      repeat: row.repeat,
    }]);
  }
  return bySuite;
}

export async function selectProposalDrafts(
  sql: Queryable,
  input: { teamId: string; projectId: string; proposalId: string },
): Promise<ProposalDrafts | null> {
  const teamId = nonEmpty(input.teamId, "teamId");
  const projectId = nonEmpty(input.projectId, "projectId");
  const proposals = await sql<Array<{ candidate_definition: SuiteCaseDefinition[]; target_suite_id: string | null; discovery: boolean }>>`
    select proposal.candidate_definition, proposal.target_suite_id,
      coalesce(source.kind = 'initial_discovery', false) as discovery
    from public.proposals proposal
    left join public.activities source on ${deliveredBy(sql, "proposal", "source")}
    where proposal.id = ${nonEmpty(input.proposalId, "proposalId")}::uuid
      and proposal.team_id = ${teamId}::uuid and proposal.project_id = ${projectId}
  `;
  const proposal = proposals[0];
  if (!proposal) return null;
  const suiteIds = proposal.target_suite_id === null ? [] : [proposal.target_suite_id];
  const cases = await selectSuiteCases(sql, { teamId, projectId, suiteIds });
  return {
    candidateDefinition: proposal.candidate_definition,
    liveCases: proposal.target_suite_id === null ? [] : cases.get(proposal.target_suite_id) ?? [],
    discovery: proposal.discovery,
  };
}

/** An edit walk's review as its report reads it: the staging draft it proves, what it delivered last, and the Suite's live Cases. */
export interface EditWalkReview {
  draft: ReviewProposal;
  final: ReviewProposal | null;
  liveCases: Array<SuiteCaseDefinition & { id: string }>;
}

/**
 * What an edit walk proved of the staged edits, read as the keep reads it:
 * its latest change_suite delivery (journey-edit-keep.ts walkFinal) against
 * the draft, beside the Suite's live Cases.
 */
export async function selectEditWalkReview(
  sql: Queryable,
  input: { teamId: string; projectId: string; draftId: string; walkActivityId: string },
): Promise<EditWalkReview | null> {
  const scope = { teamId: nonEmpty(input.teamId, "teamId"), projectId: nonEmpty(input.projectId, "projectId") };
  const draft = await readStagingDraft(sql, scope, nonEmpty(input.draftId, "draftId"));
  if (!draft?.targetSuiteId) return null;
  const final = await walkFinal(sql, nonEmpty(input.walkActivityId, "walkActivityId"), false);
  const live = (await selectSuiteCases(sql, { ...scope, suiteIds: [draft.targetSuiteId] })).get(draft.targetSuiteId) ?? [];
  return {
    draft,
    final,
    liveCases: live.map((entry) => ({
      ...entry, role: validateCaseRole(entry.role, "role"), scopeCaseId: entry.scopeCaseId ?? null, repeat: validateCaseRepeat(entry.repeat, "repeat"),
    })),
  };
}

/** The run a ShipBash alert at the root of a thread reported, and each Journey's latest verdict in it. */
export interface SlackAlertRootRun {
  runId: string;
  teamSlug: string;
  projectSlug: string;
  journeys: Array<{ title: string; verdict: string | null }>;
}

/** The run whose result message is the thread's root, or null when the root is not one of ours. */
export async function selectSlackAlertRootRun(
  sql: Queryable,
  input: { teamId: string; projectId: string; channelId: string; threadTs: string },
): Promise<SlackAlertRootRun | null> {
  const teamId = nonEmpty(input.teamId, "teamId");
  const runs = await sql<Array<{ suite_run_id: string; team_slug: string; project_slug: string }>>`
    select message.suite_run_id, team.slug as team_slug, project.slug as project_slug
    from public.slack_alert_messages message
    join public.teams team on team.id = message.team_id
    join public.projects project on project.id = message.project_id and project.team_id = message.team_id
    where message.team_id = ${teamId}::uuid
      and message.project_id = ${nonEmpty(input.projectId, "projectId")}
      and message.channel_id = ${nonEmpty(input.channelId, "channelId")}
      and message.message_ts = ${nonEmpty(input.threadTs, "threadTs")}
      and message.thread_ts is null
    limit 1
  `;
  const run = runs[0];
  if (!run) return null;
  const journeys = await sql<Array<{ title: string; verdict: string | null }>>`
    select distinct on (snapshot_case.position, snapshot_case.id) snapshot_case.title, case_run.verdict
    from public.case_runs case_run
    join public.suite_snapshot_cases snapshot_case on snapshot_case.id = case_run.snapshot_case_id
    where case_run.suite_run_id = ${run.suite_run_id}
      and snapshot_case.role = 'journey'
    order by snapshot_case.position, snapshot_case.id, case_run.attempt desc
  `;
  return { runId: run.suite_run_id, teamSlug: run.team_slug, projectSlug: run.project_slug, journeys };
}

/**
 * The project a thread belongs to when its root is a ShipBash alert, as the
 * workspace's teams posted it, or null when the root is not one of ours. An
 * archived project is asked about nowhere.
 */
export async function selectSlackAlertThreadProject(
  sql: Queryable,
  input: { slackTeamId: string; channelId: string; threadTs: string },
): Promise<{ teamId: string; projectId: string } | null> {
  const rows = await sql<Array<{ team_id: string; project_id: string }>>`
    select message.team_id, message.project_id
    from public.slack_alert_messages message
    join public.slack_workspaces workspace
      on workspace.team_id = message.team_id
      and workspace.slack_team_id = ${nonEmpty(input.slackTeamId, "slackTeamId")}
      and workspace.revoked_at is null
    join public.projects project
      on project.id = message.project_id and project.team_id = message.team_id
      and project.lifecycle_status <> 'archived'
    where message.channel_id = ${nonEmpty(input.channelId, "channelId")}
      and message.message_ts = ${nonEmpty(input.threadTs, "threadTs")}
      and message.thread_ts is null
    limit 1
  `;
  const row = rows[0];
  return row ? { teamId: row.team_id, projectId: row.project_id } : null;
}
