/**
 * Walks started from a proposal, which name it in
 * activities.source_proposal_id: the edit walks of a journey-edit staging
 * draft, and the follow-up walks that revise a walk's drafts. A walk starts,
 * by edit-run, follow-up or retry, only under the proposal's row lock, only
 * while the proposal is undecided, and only when no walk of it is still
 * running: a stage cannot slip in between the brief the walk was given and
 * the walk itself, and a proposal has one running walk at most. Discarding a
 * staging draft cancels that walk and retires what the draft's walks
 * delivered, in one transaction, so no walk delivers for a decided draft.
 */
import type postgres from "postgres";

import { TERMINAL_ACTIVITY_STATUS_VALUES } from "@shipbash/contracts/activity-lifecycle";
import type { ActivitySummary, CreateActivityInput, TenantActor } from "../types.ts";
import { cancelActivity } from "./activities.ts";
import { createActivityTransaction } from "./activity-transactions.ts";
import { iso } from "./normalize.ts";
import { proposalChanged, ProposalConflictError } from "./proposal-conflict.ts";
import { assertRunQuotaAvailable } from "./run-quota.ts";
import type { Timestamp } from "./rows.ts";
import { deliveredBy } from "./walk-deliveries.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

export interface EditWalk {
  activityId: string;
  status: ActivitySummary["status"];
}

interface DraftScope {
  teamId: string;
  projectId: string;
  draftId: string;
}

/** The latest walk of each named staging draft; a draft never walked is absent. */
export async function latestEditWalks(
  sql: Queryable,
  teamId: string,
  projectId: string,
  draftIds: readonly string[],
): Promise<Map<string, EditWalk>> {
  if (draftIds.length === 0) return new Map();
  const rows = await sql<Array<{ draft_id: string; id: string; status: ActivitySummary["status"] }>>`
    select distinct on (source_proposal_id) source_proposal_id::text as draft_id, id::text as id, status
    from public.activities
    where team_id = ${teamId}::uuid
      and project_id = ${projectId}
      and source_proposal_id = any(${sql.array([...draftIds])}::uuid[])
    order by source_proposal_id, created_at desc, id desc
  `;
  return new Map(rows.map((row) => [row.draft_id, { activityId: row.id, status: row.status }]));
}

/**
 * Whether a walk of the proposal is still at work: one started from it, or
 * the walk that delivered it, woken in place, which will deliver its list
 * again.
 */
export async function walkRunning(
  sql: Queryable,
  scope: { teamId: string; projectId: string; proposalId: string },
): Promise<boolean> {
  const rows = await sql`
    select 1
    from public.proposals proposal
    join public.activities walk
      on (walk.source_proposal_id = proposal.id and walk.team_id = proposal.team_id and walk.project_id = proposal.project_id)
      or ${deliveredBy(sql, "proposal", "walk")}
    where proposal.id = ${scope.proposalId}::uuid
      and proposal.team_id = ${scope.teamId}::uuid
      and proposal.project_id = ${scope.projectId}
      and not (walk.status = any(${sql.array([...TERMINAL_ACTIVITY_STATUS_VALUES])}::text[]))
    limit 1
  `;
  return rows.length > 0;
}

/**
 * Locks the proposal a new walk would start from, and says the version it
 * stands at: a staging draft its edit walk verifies, or the drafts a
 * follow-up walk revises. A request that already started its walk (the same
 * key, the same proposal) is a replay and passes, so the caller is answered
 * with that walk; any other is refused once the proposal is decided (a
 * staging draft is undecided while `draft`, drafts while `ready`), or while a
 * walk of it is still running.
 */
export async function lockProposalForNewWalk(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  input: DraftScope & { clientIdempotencyKey: string },
): Promise<{ updatedAt: string | null; replay: boolean }> {
  const rows = await sql<Array<{ status: string; staging: boolean; updated_at: Timestamp }>>`
    select status, coalesce(trigger ->> 'kind' = 'journey_edit', false) as staging, updated_at
    from public.proposals
    where id = ${input.draftId}::uuid
      and team_id = ${input.teamId}::uuid
      and project_id = ${input.projectId}
    for update
  `;
  const proposal = rows[0];
  const updatedAt = proposal ? iso(proposal.updated_at, "proposals.updated_at") : null;
  const started = await sql`
    select 1 from public.activities
    where team_id = ${input.teamId}::uuid
      and created_by = ${actor.userId}::uuid
      and client_idempotency_key = ${input.clientIdempotencyKey}
      and source_proposal_id = ${input.draftId}::uuid
    limit 1
  `;
  if (started.length > 0) return { updatedAt, replay: true };
  if (proposal?.status !== (proposal?.staging ? "draft" : "ready")) {
    throw proposal?.staging
      ? new ProposalConflictError("EDITS_DECIDED", "These staged edits were already kept or discarded.")
      : new ProposalConflictError("DRAFTS_DECIDED", "These drafts were already kept or discarded.");
  }
  if (await walkRunning(sql, { teamId: input.teamId, projectId: input.projectId, proposalId: input.draftId })) {
    throw new ProposalConflictError("WALK_RUNNING", "A walk of this proposal is still running.");
  }
  return { updatedAt, replay: false };
}

/**
 * Starts a follow-up walk of a proposal's drafts: the owner's change is
 * asked of a walk, never written into the drafts. The walk names the
 * proposal it revises, and its delivery supersedes it (proposals-for-job.ts).
 */
export async function startFollowUpWalkTransaction(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  input: DraftScope & { activity: CreateActivityInput; continues: string | null },
): Promise<ActivitySummary> {
  await lockProposalForNewWalk(sql, actor, { ...input, clientIdempotencyKey: input.activity.clientIdempotencyKey });
  const continued = input.continues === null ? [] : await sql<Array<{ id: string; generation: number }>>`
    select id::text as id, generation from public.activities
    where id = ${input.continues}::uuid and team_id = ${input.teamId}::uuid and project_id = ${input.projectId}
    for share
  `;
  return createActivityTransaction(sql, actor, {
    teamId: input.teamId,
    projectId: input.projectId,
    input: { ...input.activity, sourceProposalId: input.draftId },
    sourceActivityId: continued[0]?.id ?? null,
    generation: (continued[0]?.generation ?? 0) + 1,
  });
}

/**
 * Starts a walk of the staging draft as the caller read it: a draft staged
 * onto since is refused, and a stage waiting on the lock finds the walk once
 * it is let in.
 */
export async function startEditWalkTransaction(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  input: DraftScope & { expectedUpdatedAt: string; activity: CreateActivityInput; runQuota: boolean },
): Promise<ActivitySummary> {
  const lock = await lockProposalForNewWalk(sql, actor, { ...input, clientIdempotencyKey: input.activity.clientIdempotencyKey });
  if (!lock.replay && lock.updatedAt !== input.expectedUpdatedAt) throw proposalChanged();
  // A walk counts no Runs, only a verification run does, but none starts once the team has used this month's (the console's 429, the chat's refusal).
  if (!lock.replay) await assertRunQuotaAvailable(sql, input.teamId, input.runQuota);
  return createActivityTransaction(sql, actor, {
    teamId: input.teamId,
    projectId: input.projectId,
    input: { ...input.activity, sourceProposalId: input.draftId },
    sourceActivityId: null,
    generation: 1,
  });
}

/** Cancels the walk still running from the proposal (a staging draft's edit walk, a follow-up of drafts), if any. */
export async function cancelRunningEditWalks(
  sql: postgres.TransactionSql,
  input: DraftScope & { summary: string },
): Promise<void> {
  const running = await sql<Array<{ id: string }>>`
    select id::text as id from public.activities
    where team_id = ${input.teamId}::uuid
      and project_id = ${input.projectId}
      and source_proposal_id = ${input.draftId}::uuid
      and not (status = any(${sql.array([...TERMINAL_ACTIVITY_STATUS_VALUES])}::text[]))
    order by created_at, id
  `;
  for (const walk of running) await cancelActivity(sql, input.teamId, input.projectId, walk.id, input.summary);
}

/**
 * Retires what the draft's walks delivered and nobody decided. A result is
 * found by the walk its trigger names, so one delivered but not yet seated
 * on the walk's result is retired too.
 */
export async function retireEditWalkResults(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  input: DraftScope,
): Promise<void> {
  await sql`
    update public.proposals result
    set status = 'rejected', decided_by = ${actor.userId}::uuid,
        decided_at = now(), updated_at = now()
    from public.activities walk
    where result.team_id = ${input.teamId}::uuid
      and result.project_id = ${input.projectId}
      and result.status = 'ready'
      and ${deliveredBy(sql, "result", "walk")}
      and walk.source_proposal_id = ${input.draftId}::uuid
  `;
}

/**
 * A follow-up walk delivered: the drafts it revised are superseded by its
 * delivery, so the project shows one list. A staging draft is never `ready`,
 * so an edit walk leaves its draft alone.
 */
export async function supersedeRevisedDrafts(
  sql: postgres.TransactionSql,
  job: { team_id: string; activity_id: string | null },
  activity: { created_by: string },
): Promise<void> {
  if (!job.activity_id) return;
  await sql`
    update public.proposals revised
    set status = 'superseded', decided_by = ${activity.created_by}::uuid,
        decided_at = now(), updated_at = now()
    from public.activities walk
    where walk.id = ${job.activity_id}::uuid
      and walk.team_id = ${job.team_id}::uuid
      and revised.id = walk.source_proposal_id
      and revised.team_id = walk.team_id
      and revised.status = 'ready'
  `;
}
