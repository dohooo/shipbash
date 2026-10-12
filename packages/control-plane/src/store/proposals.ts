/**
 * Proposal reads and review writes: the membership-scoped list/get and
 * rejection, which for a staging draft also cancels its running edit walks
 * and retires what they delivered.
 * Nothing here edits a proposal's drafts: keeping them is draft-keep.ts, and
 * application lives in proposal-apply.ts. The tenant-store facade owns actor
 * scoping and the Project role check.
 */
import type postgres from "postgres";

import { cancelRunningEditWalks, retireEditWalkResults } from "./edit-walks.ts";
import { iso, nonEmpty } from "./normalize.ts";
import { proposalChanged } from "./proposal-conflict.ts";
import { PROPOSAL_ROW_COLUMNS, type ProposalRow, type Timestamp } from "./rows.ts";
import { mapProposal } from "./suite-maps.ts";
import { deliveredBy } from "./walk-deliveries.ts";

type ProposalRowWithTrigger = ProposalRow & {
  trigger: unknown;
  source_activity_id: string | null;
  edit_walk_draft_id: string | null;
};

import type { SuiteProposal, TenantActor } from "../types.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/**
 * Proposal ids born from an initial_discovery Activity, project-wide. The
 * review flows branch on this membership (confirm-and-run vs plain apply),
 * so it must see every initial proposal — a recent-activities window would
 * silently change an old proposal's accept behavior.
 */
export async function listInitialProposalIds(sql: Queryable, actor: TenantActor, scopedTeamId: string, scopedProjectId: string): Promise<string[]> {
  const rows = await sql<Array<{ proposal_id: string }>>`
    select proposal.id::text as proposal_id
    from public.team_memberships membership
    join public.proposals proposal on proposal.team_id = membership.team_id
    join public.activities activity on ${deliveredBy(sql, "proposal", "activity")}
    where membership.team_id = ${scopedTeamId}::uuid
      and membership.user_id = ${nonEmpty(actor.userId, "actor.userId")}::uuid
      and proposal.project_id = ${scopedProjectId}
      and activity.kind = 'initial_discovery'
  `;
  return rows.map((row) => row.proposal_id);
}

/**
 * A Proposal row with the Activity it came from and the staging draft that
 * Activity walked, reached through the reader's Team membership. The caller
 * adds its own where clause.
 */
function proposalWithOrigin(sql: Queryable): postgres.Fragment {
  return sql`
    select proposal.id, proposal.team_id, proposal.project_id, proposal.kind,
      proposal.target_suite_id, proposal.applied_suite_id, proposal.base_definition_revision,
      proposal.proposed_suite_name, proposal.product_thesis, proposal.candidate_definition, proposal.status,
      proposal.repository_commit_sha, proposal.prompt_contract_version, proposal.trigger,
      source.id::text as source_activity_id, draft.id::text as edit_walk_draft_id,
      proposal.created_at, proposal.updated_at, proposal.decided_at
    from public.team_memberships membership
    join public.proposals proposal on proposal.team_id = membership.team_id
    left join public.activities source on ${deliveredBy(sql, "proposal", "source")}
    left join public.proposals draft on draft.id = source.source_proposal_id
      and draft.team_id = source.team_id and draft.trigger ->> 'kind' = 'journey_edit'
  `;
}

export async function listProposals(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedLimit: number,
): Promise<SuiteProposal[]> {
  const rows = await sql<ProposalRowWithTrigger[]>`
    ${proposalWithOrigin(sql)}
    where membership.team_id = ${scopedTeamId}::uuid
      and membership.user_id = ${nonEmpty(actor.userId, "actor.userId")}::uuid
      and proposal.project_id = ${scopedProjectId}
    order by proposal.updated_at desc, proposal.id
    limit ${scopedLimit}
  `;
  return rows.map((row) => mapProposal(row));
}

export async function getProposal(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedProposalId: string,
): Promise<SuiteProposal | null> {
  const rows = await sql<ProposalRowWithTrigger[]>`
    ${proposalWithOrigin(sql)}
    where membership.team_id = ${scopedTeamId}::uuid
      and membership.user_id = ${actor.userId}::uuid
      and proposal.project_id = ${scopedProjectId}
      and proposal.id = ${scopedProposalId}::uuid
    limit 1
  `;
  return rows[0] ? mapProposal(rows[0]) : null;
}

async function markRejected(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  teamId: string,
  projectId: string,
  proposalId: string,
): Promise<SuiteProposal> {
  const rows = await sql<ProposalRowWithTrigger[]>`
    update public.proposals
    set status = 'rejected', decided_by = ${actor.userId}::uuid,
        decided_at = now(), updated_at = now()
    where id = ${nonEmpty(proposalId, "proposalId")}::uuid
      and team_id = ${nonEmpty(teamId, "teamId")}::uuid
      and project_id = ${nonEmpty(projectId, "projectId")}
      and status in ('draft', 'ready')
    returning ${sql([...PROPOSAL_ROW_COLUMNS, "trigger"])}
  `;
  if (!rows[0]) throw new Error("Reviewable Proposal not found.");
  return mapProposal(rows[0]);
}

/**
 * The proposal locked as the reader decided on it: still undecided, at the
 * version they read. Anything else refuses, as a keep does (draft-keep.ts).
 */
async function lockDecidedVersion(
  sql: postgres.TransactionSql,
  scope: { teamId: string; projectId: string; proposalId: string },
  expectedUpdatedAt: string,
): Promise<void> {
  const rows = await sql<Array<{ status: string; updated_at: Timestamp }>>`
    select status, updated_at from public.proposals
    where id = ${nonEmpty(scope.proposalId, "proposalId")}::uuid
      and team_id = ${nonEmpty(scope.teamId, "teamId")}::uuid
      and project_id = ${nonEmpty(scope.projectId, "projectId")}
    for update
  `;
  const row = rows[0];
  if (!row || !["draft", "ready"].includes(row.status) || iso(row.updated_at, "proposals.updated_at") !== expectedUpdatedAt) {
    throw proposalChanged();
  }
}

/** Discards the proposal; with the version the reader decided on, only while it is still that version. */
export async function rejectProposal(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  scope: { teamId: string; projectId: string; proposalId: string },
  expectedUpdatedAt: string | null,
): Promise<SuiteProposal> {
  const { teamId, projectId, proposalId } = scope;
  if (expectedUpdatedAt !== null) await lockDecidedVersion(sql, scope, expectedUpdatedAt);
  const rejected = await markRejected(sql, actor, teamId, projectId, proposalId);
  // Decided first, so no walk of it can start after: then its walk still
  // running (an edit walk, or a follow-up revising drafts) is canceled, and
  // what a staging draft's walks delivered is retired with it.
  const walked = { teamId, projectId, draftId: rejected.id };
  if (rejected.journeyEditInstructions) {
    await cancelRunningEditWalks(sql, { ...walked, summary: "The staged edits were discarded." });
    await retireEditWalkResults(sql, actor, walked);
  } else {
    await cancelRunningEditWalks(sql, { ...walked, summary: "The drafts this walk was revising were discarded." });
  }
  return rejected;
}

/**
 * Retires a staging draft whose walk was kept, and what its other walks
 * delivered. None of them is running: a draft has one running walk at most,
 * and only its latest walk, ended, is kept.
 */
export async function retireKeptDraft(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  input: { teamId: string; projectId: string; draftId: string },
): Promise<SuiteProposal> {
  const retired = await markRejected(sql, actor, input.teamId, input.projectId, input.draftId);
  await retireEditWalkResults(sql, actor, input);
  return retired;
}
