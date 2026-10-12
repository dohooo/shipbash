/**
 * The question a wrap-up leaves unanswered.
 *
 * A Discovery waiting on the owner's answer is `waiting_for_input`, and the
 * worker moves it back to `running` when the runner reports the answer. A
 * wrap-up that lands while the question is open takes another path: the
 * runner drops the request file on the sentinel and answers itself
 * WRAP_UP_REQUESTED — and reports nothing, so the worker never hears the
 * answer that would have moved the Activity. The round then closes and its
 * delivery is refused ("Running scoped Activity not found."): a whole
 * exploration lost to one click. The leg that drops
 * the sentinel (dispatch-worker-control-inbox.ts) records the withdrawal and moves
 * the Activity itself, in one transaction under its own lease.
 */
import type postgres from "postgres";

import type { DispatchJobLeaseCapability } from "../types.ts";
import { pendingActivityQuestion } from "./activity-interaction.ts";
import { appendActivityEventTransaction } from "./activity-transactions.ts";
import { lockDispatchJobCapability } from "./dispatch-capabilities.ts";
import { nonEmpty } from "./normalize.ts";

/** True when the Activity was waiting on the question and now runs again; false when nothing was waiting. */
export async function withdrawActivityQuestionForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  questionId: string,
): Promise<boolean> {
  const scopedQuestionId = nonEmpty(questionId, "questionId");
  return sql.begin(async (tx) => {
    const job = await lockDispatchJobCapability(tx, capability);
    if (job.kind !== "activity" || !job.activity_id) return false;
    return withdrawQuestion(tx, job, job.activity_id, scopedQuestionId);
  });
}

/**
 * The question a leg left open when it ended — closed by its time budget or
 * on its own words while the owner had not answered. The record names it
 * (store/activity-interaction.ts); nothing can answer it now, so the leg
 * withdraws it before it delivers, or the delivery is refused for an Activity
 * that is waiting, not running.
 */
export async function withdrawOpenActivityQuestionForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const job = await lockDispatchJobCapability(tx, capability);
    if (job.kind !== "activity" || !job.activity_id) return false;
    const open = await pendingActivityQuestion(tx, {
      teamId: job.team_id, projectId: job.project_id, activityId: job.activity_id,
    });
    return open ? withdrawQuestion(tx, job, job.activity_id, open.questionId) : false;
  });
}

async function withdrawQuestion(
  tx: postgres.TransactionSql,
  job: { team_id: string; project_id: string },
  activityId: string,
  scopedQuestionId: string,
): Promise<boolean> {
  const rows = await tx<Array<{ id: string }>>`
    update public.activities
    set status = 'running', updated_at = now()
    where id = ${activityId}::uuid
      and team_id = ${job.team_id}::uuid
      and project_id = ${job.project_id}
      and status = 'waiting_for_input'
    returning id
  `;
  if (!rows[0]) return false;
  await appendActivityEventTransaction(tx, {
    teamId: job.team_id,
    projectId: job.project_id,
    activityId,
    kind: "lifecycle",
    label: "Question withdrawn",
    bodyMarkdown: "The question was not answered before the round ended.",
    safeData: { event: "choice_withdrawn", phase: "progress", questionId: scopedQuestionId },
  });
  return true;
}
