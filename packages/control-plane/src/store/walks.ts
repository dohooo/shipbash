/**
 * The walks a conversation starts, and what each reports back.
 *
 * A walk is an Activity of its own (kind `walk`), created as the
 * conversation's creator under the lease of the turn that asked for it, with
 * the brief as its opening message and its dispatch job queued for a Sandbox.
 * Its identity is the tool call that asked for it, so one call never starts
 * two walks, and a conversation the owner stopped starts none. The thread's
 * row for it (slack_thread_work) is what its end reports through
 * (conversation-reports.ts), what the thread's Stop cancels, and what every
 * turn's opening shows while it runs (slack-thread-work.ts). A walk that
 * asks its owner a question waits for the answer the conversation gives it
 * (tell_walk), recorded the way the walk's page records one. Its protected
 * input says what it is for — a check, or an action the owner asked done —
 * and that its legs record their screen; the video a check's leg keeps goes
 * into the thread after the reply that answers the walk's report, while an
 * action's stays its evidence.
 *
 * Authorization-blind, like their neighbours: the turn is trusted by its
 * lease, the bot and the sweep by construction, and every statement is bound
 * to the team the conversation or the thread names.
 */
import type postgres from "postgres";

import { activityModelRole, modelContractFor } from "@shipbash/contracts/model-contract";
import { currentPromptContractVersion } from "@shipbash/contracts/prompt-contracts";
import { TERMINAL_ACTIVITY_STATUS_VALUES } from "@shipbash/contracts/activity-lifecycle";
import type { StoredImageRef } from "@shipbash/contracts/steer-images";
import type { WalkPurpose } from "@shipbash/runner/runtime/host-tools.mjs";
import { dispatchIdentity } from "../dispatch-identity.ts";
import { isRecord } from "../is-record.ts";
import type { ActivitySummary, DispatchJobLeaseCapability } from "../types.ts";
import { type ActivityScope, type PendingActivityQuestion, answerActivityQuestion, unansweredActivityQuestion } from "./activity-interaction.ts";
import { type ActivityOperator, NOT_A_MEMBER, conversationOperator } from "./activity-operator.ts";
import { createActivityTransaction } from "./activity-transactions.ts";
import { lockDispatchJobCapability, requireActivityId } from "./dispatch-capabilities.ts";
import { type HostRefusal, refused, runRefusal } from "./host-requests-for-job.ts";
import { nonEmpty } from "./normalize.ts";
import { runQuotaExceeded } from "./run-quota.ts";
import { latestDelivery } from "./walk-deliveries.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

export type WalkAnswer = { status: "started"; walk: { id: string; teamSlug: string; projectSlug: string } } | HostRefusal;

export interface StartWalkForJobInput {
  /** The walk's to-do line, as the agent named it. */
  title: string;
  purpose: WalkPurpose;
  /** The walk's opening message: the brief, with the owner's messages ahead of it. */
  opening: string;
  /** The images the owner sent with those messages, stored for the walk's leg, which its opening carries by reference. */
  images?: readonly StoredImageRef[];
  /** The tool call that asked for it: the walk's identity. */
  toolCallId: string;
}

/**
 * Whether an Activity's legs record their screen: only what a conversation
 * started — a walk (startWalkForJob), an edit walk (edits-for-job.ts) — whose
 * protected input says so; console discovery never does. Read once, where a
 * leg's execution input is loaded (dispatch-execution-input.ts).
 */
export function recordsScreen(protectedInput: string | null): boolean {
  if (protectedInput === null) return false;
  const parsed: unknown = JSON.parse(protectedInput);
  return isRecord(parsed) && parsed.recordScreen === true;
}

/** The thread's row for work its conversation started: what the work's end reports through, and what Stop cancels. */
export async function trackThreadWork(tx: postgres.TransactionSql, operator: ActivityOperator, workId: string, title: string): Promise<void> {
  if (!operator.threadId) return;
  await tx`
    insert into public.slack_thread_work (slack_thread_id, walk_activity_id, title)
    values (${operator.threadId}::uuid, ${workId}::uuid, ${nonEmpty(title, "title").slice(0, 200)})
    on conflict (walk_activity_id) do nothing
  `;
}

/**
 * A walk the turn's conversation asked for, queued for its Sandbox; the bell
 * is the caller's to ring. The conversation's row is locked while the walk is
 * created (activity-operator.ts), so a Stop either lands first and refuses it,
 * or waits for it and finds it among the work it cancels
 * (slack-chat/conversation-actions.ts).
 */
export async function startWalkForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  input: StartWalkForJobInput,
  runQuota: boolean,
): Promise<WalkAnswer> {
  return sql.begin(async (tx): Promise<WalkAnswer> => {
    const operator = await conversationOperator(tx, capability);
    if ("status" in operator) return operator;
    const refusal = runRefusal(operator);
    if (refusal) return refusal;
    // A walk counts no Runs, only a verification run does, but none starts once the team has used this month's.
    const exceeded = await runQuotaExceeded(tx, operator.teamId, runQuota);
    if (exceeded) return refused(exceeded.code, exceeded.message);
    const key = `walk:${nonEmpty(input.toolCallId, "toolCallId")}`;
    const dispatch = dispatchIdentity(operator.teamId, operator.projectId, "walk", input.toolCallId);
    const walk = await createActivityTransaction(tx, operator, {
      teamId: operator.teamId,
      projectId: operator.projectId,
      input: {
        kind: "walk",
        initialMessage: { message: input.opening, clientKey: `init:${key}`, images: input.images ?? [] },
        // Every walk records its screen; only a check's recording is sent into its thread (selectWalkReplay).
        protectedInput: JSON.stringify({ recordScreen: true, purpose: input.purpose }),
        triggerSource: operator.triggerSource,
        clientIdempotencyKey: key,
        semanticExecutionKey: null,
        repositoryId: operator.repositoryId,
        repositoryCommitSha: operator.repositoryCommitSha,
        promptContractVersion: currentPromptContractVersion("walk"),
        modelContract: modelContractFor(activityModelRole("walk")),
        dispatchIdentity: { identityHash: dispatch.identityHash, expiresAt: dispatch.expiresAt },
      },
      sourceActivityId: null,
      generation: 1,
    });
    await trackThreadWork(tx, operator, walk.id, input.title);
    return { status: "started", walk: { id: walk.id, teamSlug: operator.teamSlug, projectSlug: operator.projectSlug } };
  });
}

/** What tell_walk asks, as the tool reads it off the call (runner host-tools.mjs). */
export interface TellWalkInput {
  /** The walk's id. */
  walk: string;
  /** The answer as the agent passed it on. */
  answer: string;
}

export type TellWalkAnswer =
  | { status: "answered"; question: string; answer: string }
  | { status: "refused"; code: "UNKNOWN_WALK" | "NOT_A_MEMBER" | "NO_OPEN_QUESTION"; message: string }
  | { status: "refused"; code: "NOT_AN_OPTION"; message: string; options: string[] };

/** The question a walk waits on: only a walk waiting for input has one, and only while no answer has been sent for it. */
async function openWalkQuestion(sql: Queryable, scope: ActivityScope, status: ActivitySummary["status"]): Promise<PendingActivityQuestion | null> {
  return status === "waiting_for_input" ? unansweredActivityQuestion(sql, scope) : null;
}

/** The answer as the walk's question takes it: one of its options exactly, else free text where it allows it. */
function answerTo(question: PendingActivityQuestion, answer: string): { option: string | null; freeText: string | null } | null {
  if (question.options.includes(answer)) return { option: answer, freeText: null };
  return question.allowFreeText ? { option: null, freeText: answer } : null;
}

/**
 * The turn's answer to the question a walk of its thread waits on, recorded
 * for the walk's leg to take within a heartbeat (activity-interaction.ts).
 * It answers for the conversation's creator, so their membership is read
 * now, as every act for them reads it. Only an open question with no answer
 * sent is answered, and only by one of its options or, where it allows it,
 * free text. The walk's row is locked
 * while it is read and answered, so an answer its page sent first is seen
 * and this one refused; an answer from its page after this one still
 * replaces it until the leg takes it.
 */
export async function answerWalkQuestionForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  input: TellWalkInput,
): Promise<TellWalkAnswer> {
  return sql.begin(async (tx): Promise<TellWalkAnswer> => {
    const job = await lockDispatchJobCapability(tx, capability, false);
    const rows = await tx<Array<{ project_id: string; status: ActivitySummary["status"]; member: boolean }>>`
      select walk.project_id, walk.status, exists (
        select 1 from public.team_memberships membership
        where membership.team_id = thread.team_id and membership.user_id = conversation.created_by
      ) as member
      from public.slack_threads thread
      join public.activities conversation on conversation.id = thread.activity_id
      join public.slack_thread_work work on work.slack_thread_id = thread.id
      join public.activities walk on walk.id = work.walk_activity_id
      where thread.activity_id = ${requireActivityId(job)}::uuid and thread.team_id = ${job.team_id}::uuid
        and work.walk_activity_id::text = ${nonEmpty(input.walk, "walk")}
      for update of walk
    `;
    const walk = rows[0];
    if (!walk) return { status: "refused", code: "UNKNOWN_WALK", message: "No walk this conversation started has that id." };
    if (!walk.member) return NOT_A_MEMBER;
    const scope = { teamId: job.team_id, projectId: walk.project_id, activityId: input.walk };
    const question = await openWalkQuestion(tx, scope, walk.status);
    if (!question) {
      return { status: "refused", code: "NO_OPEN_QUESTION", message: "That walk is not waiting on a question: it never asked, its question was answered, or it moved on." };
    }
    const answer = answerTo(question, input.answer);
    if (!answer) {
      return { status: "refused", code: "NOT_AN_OPTION", message: "That question takes one of its options, exactly as offered.", options: question.options };
    }
    await answerActivityQuestion(tx, scope, question, { questionId: question.questionId, ...answer, note: null, skipped: false });
    return { status: "answered", question: question.prompt, answer: input.answer };
  });
}

/** What a walk's report says, read as the walk stands when the turn opens. */
export interface WalkReport {
  activityId: string;
  title: string | null;
  /** What the walk was for; an edit walk is a check. */
  purpose: WalkPurpose;
  status: ActivitySummary["status"];
  /** The leg's result: its closing words, or why it did not finish. */
  summary: string | null;
  /** The walk's last words to the owner. */
  closingWords: string | null;
  /** Why the walk waits for a sign-in, when it does. */
  signInReason: string | null;
  /** The question the walk waits on, while no answer has been sent for it. */
  question: PendingActivityQuestion | null;
  /** The proposal holding the Journeys the walk drafted, its newest delivery (walk-deliveries.ts), when it delivered one: decide_drafts decides it by the walk. */
  proposalId: string | null;
  /** The staging draft an edit walk proves (edits-for-job.ts), whose edits decide_edits decides; null for any other walk. */
  editOf: string | null;
}

function latestBody(sql: Queryable, event: string): postgres.Fragment {
  return sql`(
    select left(event.body_markdown, 2000) from public.activity_events event
    where event.activity_id = walk.id and event.team_id = walk.team_id and event.body_markdown is not null
      and event.safe_data ->> 'event' = ${event}
    order by event.sequence desc limit 1
  )`;
}

/** Whether the walk joined as `walk` was started as an action (startWalkForJob); any other walk is a check. */
function isAction(sql: Queryable): postgres.Fragment {
  return sql`(walk.protected_input::jsonb ->> 'purpose') is not distinct from 'action'`;
}

export async function selectWalkReport(sql: Queryable, input: { teamId: string; walkActivityId: string }): Promise<WalkReport | null> {
  const rows = await sql<Array<{
    id: string; project_id: string; title: string | null; action: boolean; status: ActivitySummary["status"]; summary: string | null;
    closing_words: string | null; sign_in_reason: string | null; proposal_id: string | null; edit_of: string | null;
  }>>`
    select walk.id::text as id, walk.project_id, work.title, ${isAction(sql)} as action, walk.status, result.summary,
      ${latestBody(sql, "agent_output")} as closing_words,
      ${latestBody(sql, "human_auth_requested")} as sign_in_reason,
      ${latestDelivery(sql, "walk")}::text as proposal_id,
      staging.id::text as edit_of
    from public.slack_thread_work work
    join public.activities walk on walk.id = work.walk_activity_id
    left join public.activity_results result on result.activity_id = walk.id
    left join public.proposals staging
      on staging.id = walk.source_proposal_id and staging.team_id = walk.team_id
      and staging.trigger ->> 'kind' = 'journey_edit'
    where work.walk_activity_id = ${nonEmpty(input.walkActivityId, "walkActivityId")}::uuid
      and walk.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
  `;
  const row = rows[0];
  if (!row) return null;
  const question = await openWalkQuestion(sql, { teamId: input.teamId, projectId: row.project_id, activityId: row.id }, row.status);
  return {
    activityId: row.id,
    title: row.title,
    purpose: row.action ? "action" : "check",
    status: row.status,
    summary: row.summary,
    closingWords: row.closing_words,
    signInReason: row.sign_in_reason,
    question,
    proposalId: row.proposal_id,
    editOf: row.edit_of,
  };
}

/** A finished walk's kept screen recording, as its thread is sent it. */
export interface WalkReplay {
  title: string | null;
  objectPath: string;
  sizeBytes: number | null;
}

/**
 * The screen recording the walk's last recorded leg kept (the host's
 * `activity_replay` evidence), once the walk has ended; null while it has
 * not, when it kept none, for a walk that was canceled, and for an action,
 * whose recording is evidence and no more: what it kept stays on its page,
 * and its thread is sent nothing more.
 */
export async function selectWalkReplay(sql: Queryable, input: { teamId: string; walkActivityId: string }): Promise<WalkReplay | null> {
  const rows = await sql<Array<{ title: string | null; object_path: string | null; size_bytes: string | null }>>`
    select work.title, replay.safe_data ->> 'artifactObjectPath' as object_path, replay.safe_data ->> 'sizeBytes' as size_bytes
    from public.slack_thread_work work
    join public.activities walk on walk.id = work.walk_activity_id
    join lateral (
      select event.safe_data from public.activity_events event
      where event.activity_id = walk.id and event.team_id = walk.team_id and event.safe_data ->> 'event' = 'activity_replay'
        -- Only an object under the walk's own prefix, whoever wrote the event.
        and starts_with(event.safe_data ->> 'artifactObjectPath', 'runs/activity_' || walk.id::text || '/')
      order by event.sequence desc limit 1
    ) replay on true
    where work.walk_activity_id = ${nonEmpty(input.walkActivityId, "walkActivityId")}::uuid
      and walk.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and walk.status = any(${[...TERMINAL_ACTIVITY_STATUS_VALUES]}::text[]) and walk.status <> 'canceled'
      and not ${isAction(sql)}
  `;
  const row = rows[0];
  if (!row?.object_path) return null;
  return { title: row.title, objectPath: row.object_path, sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes) };
}
