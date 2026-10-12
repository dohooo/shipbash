/**
 * Activity completion as one transaction: the durable Result row, its
 * Proposal links, the completion event, the Activity status flip, and the
 * dispatch job settlement land together — or the already-terminal Activity's
 * existing Result is returned idempotently. Callers own authorization and
 * the transaction (tenant-store facade).
 */
import type postgres from "postgres";

import { isTerminalActivityStatus } from "@shipbash/contracts/activity-lifecycle";
import { PUBLIC_ACTIVITY_RESULTS_ATTENTION_CODE_VALUES } from "@shipbash/contracts/runtime/generated/db-vocabularies.mjs";

import { releasedLease, requireActivityId } from "./dispatch-capabilities.ts";
import { iso, nonEmpty } from "./normalize.ts";
import type { DispatchJobRow, Timestamp } from "./rows.ts";
import { appendActivityEventTransaction } from "./activity-transactions.ts";
import { reportToParentConversation } from "./conversation-reports.ts";
import type {
  ActivityResultRecord,
  ActivitySummary,
  CompleteActivityInput,
} from "../types.ts";
import { expectRow } from "./expect-row.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/**
 * The column's own vocabulary is the list of reasons. Naming them here again
 * would only mean a reason added to the schema is refused by the store that
 * stores it.
 */
const ATTENTION_CODES = new Set<string>(PUBLIC_ACTIVITY_RESULTS_ATTENTION_CODE_VALUES);

/**
 * A woken discovery completes again: new proposals extend the list after the
 * earlier rounds' (positions continue), and a re-listed proposal keeps its
 * original seat.
 */
async function seatProposalResults(
  sql: postgres.TransactionSql,
  input: { teamId: string; projectId: string; activityId: string },
  proposalIds: readonly string[],
): Promise<void> {
  const positions = await sql<Array<{ next_position: number }>>`
    select coalesce(max(position) + 1, 0)::int as next_position
    from public.activity_proposal_results
    where activity_id = ${input.activityId}::uuid
  `;
  const { next_position: basePosition } = expectRow(positions, "activity_proposal_results", "select next position");
  for (const [position, proposalId] of proposalIds.entries()) {
    await sql`
      insert into public.activity_proposal_results (
        activity_id, proposal_id, team_id, project_id, position
      ) values (
        ${input.activityId}::uuid, ${proposalId}::uuid,
        ${input.teamId}::uuid, ${input.projectId}, ${basePosition + position}
      )
      on conflict (activity_id, proposal_id) do nothing
    `;
  }
}

type CompleteActivityTransactionInput = {
  teamId: string;
  projectId: string;
  activityId: string;
  input: CompleteActivityInput;
  forceCanceledStatus?: boolean;
  skipDispatchJobUpdate?: boolean;
};

/** The status flips and labels this completion writes, all derived up front. */
type CompletionOutcome = {
  expectedResultKind: ActivityResultRecord["kind"];
  activityStatus: ActivitySummary["status"];
  completionLabel: string;
  jobStatus: "canceled" | "completed" | "failed";
};

/** Derives the completion's result kind, status flips, and event label. */
function deriveCompletionOutcome(
  input: CompleteActivityTransactionInput,
  proposalIds: readonly string[],
): CompletionOutcome {
  if (input.forceCanceledStatus) {
    return {
      expectedResultKind: "canceled",
      activityStatus: "canceled",
      completionLabel: "Activity canceled",
      jobStatus: "canceled",
    };
  }
  switch (input.input.status) {
    case "completed":
      return {
        expectedResultKind: proposalIds.length > 0 ? "proposals" : "no_changes",
        activityStatus: "completed",
        completionLabel: "Activity completed",
        jobStatus: "completed",
      };
    case "needs_attention":
      return {
        expectedResultKind: "needs_attention",
        activityStatus: "needs_attention",
        completionLabel: "Activity needs attention",
        jobStatus: "failed",
      };
    case "superseded":
      return {
        expectedResultKind: "superseded",
        activityStatus: "superseded",
        completionLabel: "Activity superseded",
        jobStatus: "completed",
      };
    case "failed":
      return {
        expectedResultKind: "failed",
        activityStatus: "failed",
        completionLabel: "Activity failed",
        jobStatus: "failed",
      };
  }
}

/** Locks the Activity row and returns its status, or throws if it is gone. */
async function lockActivityForCompletion(
  sql: postgres.TransactionSql,
  input: CompleteActivityTransactionInput,
): Promise<ActivitySummary["status"]> {
  const activityRows = await sql<Array<{ status: ActivitySummary["status"] }>>`
    select status from public.activities
    where id = ${input.activityId}::uuid
      and team_id = ${input.teamId}::uuid
      and project_id = ${input.projectId}
    for update
  `;
  if (!activityRows[0]) throw new Error("Activity not found.");
  return activityRows[0].status;
}

/** Guards the caller's result kind and attention code against the outcome. */
function assertCompletionResultKind(
  input: CompleteActivityTransactionInput,
  expectedResultKind: ActivityResultRecord["kind"],
  attentionCode: ActivityResultRecord["attentionCode"],
): void {
  if (input.input.resultKind !== expectedResultKind) {
    throw new Error(`Activity result kind must be ${expectedResultKind}.`);
  }
  if (attentionCode !== null && !ATTENTION_CODES.has(attentionCode)) {
    throw new Error("Activity attentionCode is invalid.");
  }
  if (attentionCode !== null && input.input.status !== "needs_attention") {
    throw new Error("Activity attentionCode requires needs_attention status.");
  }
}

/** Confirms every listed Proposal belongs to this team and project. */
async function assertProposalsBelong(
  sql: postgres.TransactionSql,
  input: CompleteActivityTransactionInput,
  proposalIds: readonly string[],
): Promise<void> {
  if (proposalIds.length === 0) return;
  const proposals = await sql<Array<{ id: string }>>`
    select id from public.proposals
    where id = any(${sql.array([...proposalIds])}::uuid[])
      and team_id = ${input.teamId}::uuid
      and project_id = ${input.projectId}
  `;
  if (proposals.length !== proposalIds.length) {
    throw new Error("Activity Result contains a foreign or missing Proposal.");
  }
}

/** Upserts the durable Result row and returns it. */
async function insertActivityResult(
  sql: postgres.TransactionSql,
  input: CompleteActivityTransactionInput,
  attentionCode: ActivityResultRecord["attentionCode"],
  summary: string,
): Promise<ActivityResultRow> {
  const resultRows = await sql<ActivityResultRow[]>`
    insert into public.activity_results (
      activity_id, team_id, project_id, kind, summary, attention_code, recovery_action
    ) values (
      ${input.activityId}::uuid, ${input.teamId}::uuid, ${input.projectId},
      ${input.input.resultKind}, ${summary}, ${attentionCode},
      ${input.input.recoveryAction?.trim() || null}
    )
    on conflict (activity_id) do update set
      kind = excluded.kind, summary = excluded.summary,
      attention_code = excluded.attention_code,
      recovery_action = excluded.recovery_action, created_at = now()
    returning activity_id, team_id, project_id, kind, summary,
      attention_code, recovery_action, created_at
  `;
  return expectRow(resultRows, "activity_results", "insert");
}

/**
 * The completion's side effects in order: the completion event, the Activity
 * status flip, the repository change intent settlement, and (unless the caller
 * settled it) the dispatch job.
 */
async function recordActivityCompletion(
  sql: postgres.TransactionSql,
  input: CompleteActivityTransactionInput,
  completion: {
    outcome: CompletionOutcome;
    summary: string;
    attentionCode: ActivityResultRecord["attentionCode"];
    proposalIds: readonly string[];
  },
): Promise<void> {
  const { outcome, summary, attentionCode, proposalIds } = completion;
  await appendActivityEventTransaction(sql, {
    teamId: input.teamId,
    projectId: input.projectId,
    activityId: input.activityId,
    kind: "result",
    label: outcome.completionLabel,
    bodyMarkdown: summary,
    safeData: {
      resultKind: input.input.resultKind,
      status: outcome.activityStatus,
      proposalIds,
      ...(attentionCode ? { attentionCode } : {}),
    },
  });
  await sql`
    update public.activities
    set status = ${outcome.activityStatus},
        completed_at = now(), updated_at = now()
    where id = ${input.activityId}::uuid
  `;
  // A walk a conversation started reports its end to that conversation.
  await reportToParentConversation(sql, { walkActivityId: input.activityId });
  if (!input.skipDispatchJobUpdate) {
    await sql`
      update public.dispatch_jobs
      set status = ${outcome.jobStatus}, ${releasedLease(sql)},
          completed_at = now()
      where team_id = ${input.teamId}::uuid
        and activity_id = ${input.activityId}::uuid
        and kind = 'activity'
        and status in ('queued', 'leased', 'waiting')
    `;
  }
}

export async function completeActivityTransaction(
  sql: postgres.TransactionSql,
  input: CompleteActivityTransactionInput,
): Promise<ActivityResultRecord> {
  const status = await lockActivityForCompletion(sql, input);
  if (isTerminalActivityStatus(status)) {
    const existing = await readActivityResultTransaction(sql, input.teamId, input.projectId, input.activityId);
    if (existing) return existing;
    throw new Error("Terminal Activity has no durable Result.");
  }
  const proposalIds = [...new Set(input.input.proposalIds ?? [])];
  const outcome = deriveCompletionOutcome(input, proposalIds);
  const attentionCode = input.forceCanceledStatus ? null : input.input.attentionCode ?? null;
  assertCompletionResultKind(input, outcome.expectedResultKind, attentionCode);
  await assertProposalsBelong(sql, input, proposalIds);
  const summary = nonEmpty(input.input.summary, "summary");
  const resultRow = await insertActivityResult(sql, input, attentionCode, summary);
  await seatProposalResults(sql, input, proposalIds);
  await recordActivityCompletion(sql, input, { outcome, summary, attentionCode, proposalIds });
  return activityResultFrom(resultRow, proposalIds);
}

/**
 * Ends a Dispatch Job's Activity in the Job's own scope. The Job row is the
 * caller's to settle, so the completion leaves it alone.
 */
export async function completeJobActivity(
  sql: postgres.TransactionSql,
  job: DispatchJobRow,
  input: CompleteActivityInput,
  forceCanceledStatus = false,
): Promise<void> {
  await completeActivityTransaction(sql, {
    teamId: job.team_id,
    projectId: job.project_id,
    activityId: requireActivityId(job),
    input,
    forceCanceledStatus,
    skipDispatchJobUpdate: true,
  });
}

type ActivityResultRow = {
  activity_id: string;
  team_id: string;
  project_id: string;
  kind: ActivityResultRecord["kind"];
  summary: string;
  attention_code: ActivityResultRecord["attentionCode"];
  recovery_action: string | null;
  created_at: Timestamp;
};

/** The result record as the API reads it, from the row the insert returned. */
function activityResultFrom(row: ActivityResultRow, proposalIds: ActivityResultRecord["proposalIds"]): ActivityResultRecord {
  return {
    activityId: row.activity_id,
    teamId: row.team_id,
    projectId: row.project_id,
    kind: row.kind,
    summary: row.summary,
    attentionCode: row.attention_code,
    recoveryAction: row.recovery_action,
    proposalIds,
    createdAt: iso(row.created_at, "activity_results.created_at"),
  };
}

export async function readActivityResultTransaction(
  sql: Queryable,
  teamId: string,
  projectId: string,
  activityId: string,
): Promise<ActivityResultRecord | null> {
  const rows = await sql<Array<ActivityResultRow & { proposal_ids: string[] }>>`
    select result.activity_id, result.team_id, result.project_id, result.kind,
      result.summary, result.attention_code, result.recovery_action, result.created_at,
      coalesce(array_agg(link.proposal_id order by link.position)
        filter (where link.proposal_id is not null), '{}'::uuid[]) as proposal_ids
    from public.activity_results result
    left join public.activity_proposal_results link on link.activity_id = result.activity_id
    where result.activity_id = ${activityId}::uuid
      and result.team_id = ${teamId}::uuid
      and result.project_id = ${projectId}
    group by result.activity_id, result.team_id, result.project_id,
      result.kind, result.summary, result.attention_code,
      result.recovery_action, result.created_at
  `;
  if (!rows[0]) return null;
  return activityResultFrom(rows[0], rows[0].proposal_ids);
}
