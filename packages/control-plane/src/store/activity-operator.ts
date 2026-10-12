/**
 * Who acts under a leg's lease, read once: the creator of the Activity whose
 * leg holds it — the conversation's, for a chat's acts and the walks it
 * starts; a Discovery's or a walk's, for the edit it stages. The Activity's
 * row is locked as the act's own event will lock it, so a Stop either lands
 * before the act and refuses it or waits for it and cancels what it started,
 * and two acts of one turn take their turns; the creator's membership and the
 * Project are held for share while the act runs.
 */
import type postgres from "postgres";

import { HOST_KINDS } from "@shipbash/contracts/runtime/discovery-surface.mjs";

import type { ActivitySummary, DispatchJobLeaseCapability } from "../types.ts";
import { lockDispatchJobCapability, requireActivityId } from "./dispatch-capabilities.ts";

/** Who acts: the Activity and its creator, the Project with its slugs, and what the Activity carries into the work it starts. */
export interface ActivityOperator {
  activityId: string;
  teamId: string;
  projectId: string;
  userId: string;
  teamSlug: string;
  projectSlug: string;
  archived: boolean;
  /** The owner pressed Stop on the turn at work: it starts nothing new. */
  stopped: boolean;
  triggerSource: ActivitySummary["triggerSource"];
  repositoryId: string | null;
  repositoryCommitSha: string | null;
  /** The Slack thread a conversation answers in, whose work its acts start; null for any other Activity. */
  threadId: string | null;
}

/** The one answer for a creator who left the team, whatever ShipBash was to do for them. */
export interface NotAMember {
  status: "refused";
  code: "NOT_A_MEMBER";
  message: string;
}

export const NOT_A_MEMBER: NotAMember = {
  status: "refused",
  code: "NOT_A_MEMBER",
  message: "The person ShipBash acts for here is no longer a member of the project's team, so ShipBash cannot act for them.",
};

interface ActivityRow {
  kind: string;
  created_by: string | null;
  stopped: boolean;
  trigger_source: ActivitySummary["triggerSource"];
  repository_id: string | null;
  repository_commit_sha: string | null;
  thread_id: string | null;
}

async function lockOperator(
  sql: postgres.TransactionSql,
  capability: DispatchJobLeaseCapability,
  admitted: (kind: string) => string | null,
): Promise<ActivityOperator | NotAMember> {
  const job = await lockDispatchJobCapability(sql, capability, false);
  const activityId = requireActivityId(job);
  const activities = await sql<ActivityRow[]>`
    select activity.kind, activity.created_by::text as created_by, activity.wrap_up_requested_at is not null as stopped,
      activity.trigger_source, activity.repository_id::text as repository_id, activity.repository_commit_sha,
      thread.id::text as thread_id
    from public.activities activity
    left join public.slack_threads thread on thread.activity_id = activity.id
    where activity.id = ${activityId}::uuid and activity.team_id = ${job.team_id}::uuid and activity.project_id = ${job.project_id}
    for no key update of activity
  `;
  const activity = activities[0];
  const refusal = admitted(activity?.kind ?? "unknown");
  if (!activity || refusal) throw new Error(refusal ?? "The Activity is gone.");
  const members = await sql<Array<{ team_slug: string; project_slug: string; lifecycle_status: string }>>`
    select team.slug as team_slug, project.slug as project_slug, project.lifecycle_status
    from public.team_memberships membership
    join public.teams team on team.id = membership.team_id
    join public.projects project on project.team_id = membership.team_id and project.id = ${job.project_id}
    where membership.team_id = ${job.team_id}::uuid and membership.user_id = ${activity.created_by}::uuid
    for share of membership, project
  `;
  const member = members[0];
  if (!activity.created_by || !member) return NOT_A_MEMBER;
  return {
    activityId,
    teamId: job.team_id,
    projectId: job.project_id,
    userId: activity.created_by,
    teamSlug: member.team_slug,
    projectSlug: member.project_slug,
    archived: member.lifecycle_status === "archived",
    stopped: activity.stopped,
    triggerSource: activity.trigger_source,
    repositoryId: activity.repository_id,
    repositoryCommitSha: activity.repository_commit_sha,
    threadId: activity.thread_id,
  };
}

/** The conversation's creator, acting under the turn's lease; only a conversation's leg acts this way. */
export function conversationOperator(sql: postgres.TransactionSql, capability: DispatchJobLeaseCapability): Promise<ActivityOperator | NotAMember> {
  return lockOperator(sql, capability, (kind) => (HOST_KINDS.includes(kind) ? null : "Only a conversation acts for its owner."));
}

/** The creator of an Activity of `kinds`, acting for it under its leg's lease. */
export function activityOperator(
  sql: postgres.TransactionSql,
  capability: DispatchJobLeaseCapability,
  kinds: readonly string[],
): Promise<ActivityOperator | NotAMember> {
  return lockOperator(sql, capability, (kind) => (kinds.includes(kind) ? null : `An Activity of kind ${kind} does not act for its owner here.`));
}
