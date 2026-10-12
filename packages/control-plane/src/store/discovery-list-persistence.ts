/**
 * How a Discovery's Journey list lands as a Proposal: re-based on the Suite
 * as it is now, replaced in place across the Activity's rounds, and
 * superseding the list of the Activity it retried. createProposalForJob
 * (proposals-for-job.ts) calls these inside its transaction.
 */
import type postgres from "postgres";

import { DiscoveryListConflictError } from "./discovery-list-conflict.ts";
import { sameCandidateList } from "./discovery-list-content.ts";
import { journeyCheckpoints, journeySteps, jsonValue, nonEmpty, storedPreconditions } from "./normalize.ts";
import { resolveProposalTarget } from "./proposal-target.ts";
import { type DispatchJobRow, type NormalizedSuiteCaseInput, PROPOSAL_ROW_COLUMNS, type ProposalRow } from "./rows.ts";
import { mapProposal } from "./suite-maps.ts";
import { deliveredBy } from "./walk-deliveries.ts";
import type { MutableSuiteCaseInput, SuiteProposal } from "../types.ts";

interface CurrentSuiteCaseRow {
  id: string;
  title: string;
  steps: unknown;
  category: string;
  checkpoints: unknown;
  why_it_matters: string | null;
  preconditions: unknown;
  role: NormalizedSuiteCaseInput["role"];
  scope_case_id: string | null;
  repeat: NormalizedSuiteCaseInput["repeat"];
  enabled: boolean;
  archived_at: Date | string | null;
}

/** Every Case of the Suite as stored, unchanged, in position order. */
async function currentSuiteCases(sql: postgres.TransactionSql, teamId: string, suiteId: string): Promise<NormalizedSuiteCaseInput[]> {
  const rows = await sql<CurrentSuiteCaseRow[]>`
    select id, title, steps, category, checkpoints, why_it_matters, preconditions,
      role, scope_case_id, repeat, enabled, archived_at
    from public.suite_cases
    where suite_id = ${suiteId}::uuid and team_id = ${teamId}::uuid
    order by position, id
  `;
  return rows.map((row): NormalizedSuiteCaseInput => ({
    id: row.id,
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
    archived: row.archived_at !== null,
  }));
}

/**
 * Whether the Proposal is a Discovery's list: delivered under an Activity
 * job of an initial discovery. Such a list is seated on the Suite as it is
 * when applied (proposal-apply.ts), never superseded by the Suite having moved.
 */
export async function isDiscoveryList(sql: postgres.TransactionSql, proposalId: string): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    select proposal.id
    from public.proposals proposal
    join public.activities activity on ${deliveredBy(sql, "proposal", "activity")}
    where proposal.id = ${proposalId}::uuid
      and activity.kind = 'initial_discovery'
    limit 1
  `;
  return rows.length > 0;
}

/**
 * A Discovery's list applied: every Case the Suite holds now, as stored, and
 * the list's additions — the candidates whose id is no Case of the Suite —
 * on top. The approved entries come from the Suite, never from the review's
 * body, so an owner edit to the Suite made after the delivery is kept, an
 * approved row the review omitted is not archived, and a Suite that moved
 * does not set the list aside.
 */
export async function seatDiscoveryChange(
  sql: postgres.TransactionSql,
  teamId: string,
  suiteId: string,
  candidates: readonly NormalizedSuiteCaseInput[],
): Promise<NormalizedSuiteCaseInput[]> {
  const current = await currentSuiteCases(sql, teamId, suiteId);
  const held = new Set(current.map((suiteCase) => suiteCase.id));
  return [...current, ...candidates.filter((candidate) => !held.has(candidate.id))];
}

/**
 * A Discovery explores against the Suite snapshot its leg was dispatched
 * with; the owner may edit the Suite meanwhile. Its change is then re-based
 * on the Suite as it is now: every current Case unchanged, as stored, and
 * the Journeys the walk added on top — the approved entries the list carried
 * were read-only copies of the old snapshot, so nothing of the agent's is
 * lost by replacing them. A Suite that is gone cannot be re-based on; that
 * is the one conflict left, and it ends the Activity needs-attention rather
 * than failed.
 */
export async function rebaseDiscoveryChange(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
  input: { targetSuiteId: string | null; baseDefinitionRevision: number | null; candidateCases: readonly MutableSuiteCaseInput[] },
  normalized: NormalizedSuiteCaseInput[],
): Promise<{ cases: NormalizedSuiteCaseInput[]; baseDefinitionRevision: number }> {
  const suiteId = nonEmpty(input.targetSuiteId ?? "", "targetSuiteId");
  const base = input.baseDefinitionRevision;
  if (base === null || !Number.isInteger(base) || base < 1) {
    throw new Error("baseDefinitionRevision must be a positive integer.");
  }
  const suites = await sql<Array<{ definition_revision: number }>>`
    select definition_revision from public.suites
    where id = ${suiteId}::uuid and team_id = ${job.team_id}::uuid and project_id = ${job.project_id}
      and lifecycle_status = 'active'
    for share
  `;
  if (!suites[0]) throw new DiscoveryListConflictError("the Suite the list was explored against is gone.");
  const current = suites[0].definition_revision;
  if (current === input.baseDefinitionRevision) return { cases: normalized, baseDefinitionRevision: current };
  const added = normalized.filter((_, index) => input.candidateCases[index]?.id === undefined);
  return { baseDefinitionRevision: current, cases: [...(await currentSuiteCases(sql, job.team_id, suiteId)), ...added] };
}

/** Whether the undecided list this round replaces already holds what it delivers (discovery-list-content.ts). */
async function deliversHeldList(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
  list: {
    kind: string;
    targetSuiteId: string | null;
    baseRevision: number | null;
    proposedName: string | null;
    productThesis: string | null;
    cases: postgres.JSONValue;
  },
): Promise<boolean> {
  const rows = await sql<Array<{
    kind: string; target_suite_id: string | null; base_definition_revision: number | null;
    proposed_suite_name: string | null; product_thesis: string | null; candidate_definition: unknown;
  }>>`
    select kind, target_suite_id, base_definition_revision, proposed_suite_name, product_thesis, candidate_definition
    from public.proposals
    where team_id = ${job.team_id}::uuid
      and project_id = ${job.project_id}
      and status = 'ready'
      and decided_at is null
      and trigger ->> 'source' = 'activity_job'
      and trigger ->> 'activityId' = ${job.activity_id}
    for update
  `;
  const held = rows[0];
  return held !== undefined
    && held.kind === list.kind
    && held.target_suite_id === list.targetSuiteId
    && held.base_definition_revision === list.baseRevision
    && held.proposed_suite_name === list.proposedName
    && held.product_thesis === list.productThesis
    && sameCandidateList(held.candidate_definition, list.cases);
}

/**
 * A Discovery's Journey list grows and gets edited across rounds, but it is
 * ONE deliverable: a later round replaces the still-undecided proposal in
 * place, so the review link stays stable and the list never duplicates. This
 * runs BEFORE the same-job idempotency return: a steered follow-up round
 * delivers a DIFFERENT list under the same dispatch job, and the overwrite is
 * idempotent on its own — replaying identical content is a no-op, so retry
 * safety is kept without freezing the first round's list. Deliberately keyed
 * on activityId, NOT the leg identity: a woken leg (rotated identity,
 * wakeDeliveredActivity) is the next round of the SAME deliverable and MUST
 * replace the still-undecided list in place. So, unlike the identity-scoped
 * idempotency SELECT, this is not identity-gated — gating it would strand a
 * second, duplicate Journey list. The overwrite re-stamps the CURRENT leg's
 * identityHash onto the row it updates in place: whoever last writes the
 * list signs it. An UNDECIDED row is always caught here, never by the
 * SELECT; but once the list is decided, a same-leg replay skips this (decided_at
 * is set) and DOES fall through to the SELECT — and because the row now
 * carries this leg's identity, the SELECT matches it and the replay stays
 * idempotent instead of inserting a duplicate.
 *
 * Either kind: a list seeded from the approved Suite is delivered as a
 * change_suite on it, and a later leg's delivery re-targets the row (its base
 * revision follows the Suite the leg saw), so kind and target are rewritten
 * with the list.
 *
 * `updated_at` is the version a keep is decided on, so it moves only when
 * what the owner reviews does: a round that delivers the same list (a
 * conversation's leg that only answered) keeps the list as it is held, ids
 * and version included, so a review or a Slack card opened on it stays
 * current.
 */
export async function replaceUndecidedDiscoveryList(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
  input: Parameters<typeof resolveProposalTarget>[1] & { sourceIndex: number },
  list: {
    cases: NormalizedSuiteCaseInput[];
    productThesis: string | null;
    repositoryCommitSha: string | null;
    promptContractVersion: string;
    identityHash: string;
  },
): Promise<SuiteProposal | null> {
  const target = await resolveProposalTarget(sql, input, job);
  const delivered = jsonValue(list.cases);
  const same = await deliversHeldList(sql, job, {
    kind: input.kind,
    targetSuiteId: target.targetSuiteId,
    baseRevision: target.baseRevision,
    proposedName: target.proposedName,
    productThesis: list.productThesis,
    cases: delivered,
  });
  const undecided = await sql<ProposalRow[]>`
    update public.proposals
    set kind = ${input.kind},
        target_suite_id = ${target.targetSuiteId}::uuid,
        base_definition_revision = ${target.baseRevision},
        proposed_suite_name = ${target.proposedName},
        candidate_definition = ${same ? sql`candidate_definition` : sql.json(delivered)},
        product_thesis = ${list.productThesis},
        repository_commit_sha = ${list.repositoryCommitSha},
        prompt_contract_version = ${list.promptContractVersion},
        trigger = trigger || ${sql.json({ dispatchJobId: job.id, sourceIndex: input.sourceIndex, identityHash: list.identityHash })},
        updated_at = ${same ? sql`updated_at` : sql`now()`}
    where team_id = ${job.team_id}::uuid
      and project_id = ${job.project_id}
      and status = 'ready'
      and decided_at is null
      and trigger ->> 'source' = 'activity_job'
      and trigger ->> 'activityId' = ${job.activity_id}
    returning ${sql(PROPOSAL_ROW_COLUMNS)}
  `;
  return undecided[0] ? mapProposal(undecided[0]) : null;
}

/**
 * A retry, or a follow-up that continues a Discovery, inherits its source
 * Activity's undecided list (the store is seeded from it) and delivers the
 * list under its own row; the source's row is then a stale copy of the same
 * deliverable and is superseded, so the project never shows two lists for
 * one Discovery.
 */
export async function supersedeRetriedDiscoveryList(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
  activity: { created_by: string },
): Promise<void> {
  await sql`
    update public.proposals proposal
    set status = 'superseded', decided_by = ${activity.created_by}::uuid,
        decided_at = now(), updated_at = now()
    from public.activities retry
    where retry.id = ${job.activity_id}::uuid
      and retry.team_id = ${job.team_id}::uuid
      and retry.source_activity_id is not null
      and proposal.team_id = ${job.team_id}::uuid
      and proposal.project_id = ${job.project_id}
      and proposal.status = 'ready'
      and proposal.decided_at is null
      and proposal.trigger ->> 'source' = 'activity_job'
      and proposal.trigger ->> 'activityId' = retry.source_activity_id::text
  `;
}
