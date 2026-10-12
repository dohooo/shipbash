/**
 * The owner's Stop on a live Discovery leg, on the record.
 *
 * The API records the request here and nothing else: the record is what
 * reaches the leg. The heartbeat that renews the leg's lease reads it in the
 * Activity's control inbox (store/activity-interaction.ts) and the leg drops
 * the wrapup sentinel into its own control mount
 * (dispatch-worker-control-inbox.ts) — wherever the leg runs, a laptop
 * container or a Vercel Sandbox, no other process has to reach it.
 * The same record hard-cancels a leg still running WRAP_UP_GRACE_SECONDS
 * later (store/dispatch-claims.ts) and gives the console its stopping state.
 * The first request is the one that counts — a repeated Stop neither moves
 * the deadline nor writes a second line — and the wrap_up_requested event is
 * the conversation's "Stop requested" line. A wake of the same Activity
 * clears the request (store/activities.ts wakeDeliveredActivity).
 */
import type postgres from "postgres";

import { appendActivityEventTransaction } from "./activity-transactions.ts";
import { nonEmpty } from "./normalize.ts";

/** How long a leg may keep running after the wrap-up was requested. */
export const WRAP_UP_GRACE_SECONDS = 60;

export interface RequestActivityWrapUpInput {
  teamId: string;
  projectId: string;
  activityId: string;
}

/** True when this call recorded the request; false when one was already on record or nothing was live. */
export async function requestActivityWrapUp(
  tx: postgres.TransactionSql,
  input: RequestActivityWrapUpInput,
): Promise<boolean> {
  const teamId = nonEmpty(input.teamId, "teamId");
  const projectId = nonEmpty(input.projectId, "projectId");
  const activityId = nonEmpty(input.activityId, "activityId");
  const rows = await tx<Array<{ id: string }>>`
    update public.activities
    set wrap_up_requested_at = now(), updated_at = now()
    where id = ${activityId}::uuid
      and team_id = ${teamId}::uuid
      and project_id = ${projectId}
      and wrap_up_requested_at is null
      and status in ('running', 'waiting_for_input')
    returning id
  `;
  if (!rows[0]) return false;
  await appendActivityEventTransaction(tx, {
    teamId,
    projectId,
    activityId,
    kind: "lifecycle",
    label: "Stop requested",
    bodyMarkdown: "Stop requested; the agent is wrapping up.",
    safeData: { event: "wrap_up_requested", phase: "progress" },
  });
  return true;
}
