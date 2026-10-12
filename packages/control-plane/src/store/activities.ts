/**
 * Activity reads and the owner-facing lifecycle writes: the membership-scoped
 * list and detail (events + result + recording), cancellation (which settles
 * the dispatch job only when no live lease can), and the waiting-for-auth
 * park/resume pair (a person's wait never rides on a runtime).
 * The tenant-store facade owns actor scoping and the Project role checks.
 */
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { currentPromptContractVersion } from "@shipbash/contracts/prompt-contracts";
import { activityKnowledgeSurface } from "@shipbash/contracts/runtime/discovery-surface.mjs";
import { PUBLIC_ACTIVITIES_KIND_VALUES } from "@shipbash/contracts/runtime/generated/db-vocabularies.mjs";
import { type SlackLineFacts, slackLineFacts } from "@shipbash/contracts/slack-line";
import { type SteerImage, steerImages } from "@shipbash/contracts/steer-images";
import type { ActivityDetail, ActivityResultRecord, ActivitySummary, TenantActor } from "../types.ts";
import { completeActivityTransaction, readActivityResultTransaction } from "./activity-completion.ts";
import { releasedLease } from "./dispatch-capabilities.ts";
import { iso, nonEmpty } from "./normalize.ts";
import type { ActivityEventRow, ActivityRow, Timestamp } from "./rows.ts";
import { mapActivity, mapActivityEvent } from "./workspace-maps.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** The kinds a message wakes once delivered: the ones that converse (Discovery, a conversation). */
const INTERACTIVE_KINDS = PUBLIC_ACTIVITIES_KIND_VALUES.filter((kind) => activityKnowledgeSurface(kind).interacts);

/** Today's contract version for each Activity kind: what a woken or resumed leg runs on. */
const CURRENT_PROMPT_VERSIONS: Record<string, string> = Object.fromEntries(
  PUBLIC_ACTIVITIES_KIND_VALUES.map((kind) => [kind, currentPromptContractVersion(kind)]),
);

/** The row's own kind's current contract version, as a SQL expression. */
function currentPromptVersion(sql: Queryable): postgres.Fragment {
  return sql`(${sql.json(CURRENT_PROMPT_VERSIONS)}::jsonb ->> kind)`;
}

// The detail alone carries the wrap-up request: the list has no stop control.
type ActivityDetailRow = ActivityRow & { wrap_up_requested_at: Timestamp | null; source_proposal_id: string | null };

export async function listActivities(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedLimit: number,
): Promise<ActivitySummary[]> {
  const rows = await sql<ActivityRow[]>`
    select activity.id, activity.team_id, activity.project_id, activity.kind,
      activity.trigger_source, activity.status,
      activity.source_activity_id, activity.generation, activity.repository_id,
      activity.repository_commit_sha, activity.prompt_contract_version,
      activity.created_at, activity.updated_at, activity.started_at, activity.completed_at
    from public.team_memberships membership
    join public.activities activity on activity.team_id = membership.team_id
    where membership.team_id = ${scopedTeamId}::uuid
      and membership.user_id = ${nonEmpty(actor.userId, "actor.userId")}::uuid
      and activity.project_id = ${scopedProjectId}
    order by activity.updated_at desc, activity.id
    limit ${scopedLimit}
  `;
  return rows.map((row) => mapActivity(row));
}

export async function getActivityDetail(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
  scopedActivityId: string,
): Promise<ActivityDetail | null> {
  const rows = await sql<ActivityDetailRow[]>`
    select activity.id, activity.team_id, activity.project_id, activity.kind,
      activity.trigger_source, activity.status,
      activity.source_activity_id, activity.generation, activity.repository_id,
      activity.repository_commit_sha, activity.prompt_contract_version,
      activity.created_at, activity.updated_at, activity.started_at, activity.completed_at,
      activity.wrap_up_requested_at, activity.source_proposal_id::text as source_proposal_id
    from public.team_memberships membership
    join public.activities activity on activity.team_id = membership.team_id
    where membership.team_id = ${scopedTeamId}::uuid
      and membership.user_id = ${actor.userId}::uuid
      and activity.project_id = ${scopedProjectId}
      and activity.id = ${scopedActivityId}::uuid
    limit 1
  `;
  if (!rows[0]) return null;
  const events = await sql<ActivityEventRow[]>`
    select id, team_id, project_id, activity_id, sequence, kind,
      label, body_markdown, safe_data, created_at
    from public.activity_events
    where team_id = ${scopedTeamId}::uuid
      and project_id = ${scopedProjectId}
      and activity_id = ${scopedActivityId}::uuid
    order by sequence, id
  `;
  return {
    activity: mapActivity(rows[0]),
    wrapUpRequestedAt: iso(rows[0].wrap_up_requested_at, "activities.wrap_up_requested_at"),
    events: events.map((row) => mapActivityEvent(row)),
    result: await readActivityResultTransaction(sql, scopedTeamId, scopedProjectId, scopedActivityId),
    sourceProposalId: rows[0].source_proposal_id,
  };
}

export async function cancelActivity(
  sql: postgres.TransactionSql,
  teamId: string,
  projectId: string,
  activityId: string,
  summary: string,
): Promise<ActivityResultRecord> {
  const jobs = await sql<Array<{ held: boolean }>>`
    select status = 'leased' and lease_expires_at > clock_timestamp() as held
    from public.dispatch_jobs
    where team_id = ${nonEmpty(teamId, "teamId")}::uuid
      and project_id = ${nonEmpty(projectId, "projectId")}
      and activity_id = ${nonEmpty(activityId, "activityId")}::uuid
      and kind = 'activity'
    limit 1
    for update
  `;
  return completeActivityTransaction(sql, {
    teamId,
    projectId,
    activityId,
    input: {
      status: "failed",
      resultKind: "canceled",
      summary: nonEmpty(summary, "summary"),
      proposalIds: [],
    },
    forceCanceledStatus: true,
    // Keep a live lease intact until its heartbeat observes cancellation and
    // the worker performs the terminal Job transition itself. An expired one
    // can no longer authorize any write, so nobody is left to do that: settle
    // it here rather than leave the Job stranded and its slot occupied.
    skipDispatchJobUpdate: jobs[0]?.held === true,
  });
}

/**
 * The wake bell for a delivered conversation: the owner spoke, so the SAME
 * Activity goes back to the queue and its next leg resumes the SAME pi
 * session with the queued message folded in. The dispatch job is revived in
 * place — one job per Activity is the queue's identity model — under the
 * identity the waking message names (`activity-wake:<clientKey>`). False when
 * no message wakes it now: it is live, parked, of a kind that does not
 * converse, or another message's bell already rang.
 */
export async function wakeDeliveredActivity(
  sql: postgres.TransactionSql,
  scope: { teamId: string; projectId: string; activityId: string },
  clientKey: string,
): Promise<boolean> {
  const { teamId, projectId, activityId } = scope;
  // The woken leg runs with today's prompt contract: keeping the version
  // pinned at creation would strand a long-sleeping Activity on a superseded
  // contract the runtime refuses to resolve (retry re-pins the same way).
  // started_at clears so the next dispatch claim re-arms it
  // (coalesce(started_at, now())): "running time" measures the woken leg,
  // not the sleep since the first leg began. The wrap-up request clears with
  // it: the owner's message starts a round nobody has asked to stop. A leg
  // that ended asking for attention wakes too: the owner's answer is that
  // attention.
  const rows = await sql`
    update public.activities
    set status = 'queued', completed_at = null, started_at = null,
        wrap_up_requested_at = null,
        prompt_contract_version = ${currentPromptVersion(sql)},
        updated_at = now()
    where id = ${nonEmpty(activityId, "activityId")}::uuid
      and team_id = ${nonEmpty(teamId, "teamId")}::uuid
      and project_id = ${nonEmpty(projectId, "projectId")}
      and status = any(${["completed", "needs_attention"]}::text[])
      and kind = any(${INTERACTIVE_KINDS}::text[])
    returning id
  `;
  if (!rows[0]) return false;
  const identityHash = createHash("sha256")
    .update(`${teamId}\0${projectId}\0activity-wake:${nonEmpty(clientKey, "clientKey")}`, "utf8").digest("hex");
  await sql`
    update public.dispatch_jobs
    set status = 'queued', identity_hash = ${identityHash},
        expires_at = now() + interval '30 days',
        ${releasedLease(sql)}, failure_reason = null,
        completed_at = null
    where team_id = ${teamId}::uuid
      and activity_id = ${activityId}::uuid
      and kind = 'activity'
  `;
  return true;
}

// Moves a run parked on sign-in back to queued and revives its waiting job.
// The single-row guard on status = 'waiting_for_auth' is the whole race
// control: whoever moves it first wins, and a caller arriving second sees
// false — the run is already queued either way.
// A resumed leg runs today's contract, as a woken one does: the version on
// the row records what ran, it does not pin the Activity to the contract it
// started under — a leg refused for a stale version would fail the whole run
// at the next release.
async function moveWaitingActivityToQueued(sql: postgres.TransactionSql, teamId: string, projectId: string, activityId: string): Promise<boolean> {
  const rows = await sql`
    update public.activities
    set status = 'queued', updated_at = now(),
        prompt_contract_version = ${currentPromptVersion(sql)}
    where id = ${nonEmpty(activityId, "activityId")}::uuid
      and team_id = ${nonEmpty(teamId, "teamId")}::uuid
      and project_id = ${nonEmpty(projectId, "projectId")}
      and status = 'waiting_for_auth'
    returning id
  `;
  if (!rows[0]) return false;
  await sql`
    update public.dispatch_jobs
    set status = 'queued', ${releasedLease(sql)}
    where team_id = ${teamId}::uuid
      and activity_id = ${activityId}::uuid
      and kind = 'activity'
      and status = 'waiting'
  `;
  return true;
}

// A finished sign-in must find its parked run: a vanished waiting row is the
// human-auth gateway's error to surface, unchanged.
export async function resumeActivityAfterAuth(sql: postgres.TransactionSql, teamId: string, projectId: string, activityId: string): Promise<void> {
  if (!(await moveWaitingActivityToQueued(sql, teamId, projectId, activityId))) {
    throw new Error("Waiting Activity not found.");
  }
}

/**
 * The one guard every message meets: a delivered conversation wakes, and a
 * run of ANY kind parked at a login gate resumes the way a sign-in does, the
 * queued steer materializing in the fresh round. False when it moves nothing:
 * the Activity is live, or another message or a sign-in already moved it —
 * never the error the sign-in path raises.
 */
export async function wakeForSteer(sql: postgres.TransactionSql, scope: { teamId: string; projectId: string; activityId: string }, clientKey: string): Promise<boolean> {
  return await wakeDeliveredActivity(sql, scope, clientKey)
    || await moveWaitingActivityToQueued(sql, scope.teamId, scope.projectId, scope.activityId);
}

/**
 * Steers accepted while no leg was live: every steer_requested whose clientKey
 * has no steer_folded acknowledgement yet, oldest first. The next leg
 * materializes these into its steer channel before the agent starts.
 *
 * The direct parent (source_activity_id) is included for RETRY: a message
 * that missed a failed round stays owed to the conversation, and the retry is
 * its next leg under a new activity id. (A delivered discovery wakes the SAME
 * activity, so no lineage is needed there.) The folded check counts only acks
 * on THIS activity: a retry is a fresh session that never heard the parent's
 * instructions, so even the parent's folded messages are owed to it again —
 * while the same activity's own folds still stop a wake from repeating them.
 * One generation only.
 */
/** A steer as the record keeps it, before the delivery dedupes retries. */
export interface UndeliveredSteerRow {
  body_markdown: string | null;
  client_key: string;
  created_at: string | Date;
  /** safe_data.images; the leg's heartbeat reads none. */
  images?: unknown;
  /** safe_data.origin, .author and .slack, which a conversation's turn reads a message by. */
  origin?: string | null;
  author?: string | null;
  slack?: unknown;
}

/**
 * A steer owed to the Activity, with the images it carries by reference: a
 * message, or an aside — context, not a request (activity-interaction.ts
 * recordAside); by whom, as the chat names them, and where it stands in its
 * Slack thread, when one carried it.
 */
export interface OwedSteer {
  kind: "message" | "aside";
  message: string;
  clientKey: string;
  requestedAtMs: number;
  images: SteerImage[];
  by: string | null;
  slack: SlackLineFacts | null;
}

/** The Activity the fragments below read under, as the CTE named `activity`. */
export function scopedActivity(
  sql: Queryable,
  input: { teamId: string; projectId: string; activityId: string },
): postgres.Fragment {
  return sql`
    select id, team_id, project_id, source_activity_id from public.activities
    where id = ${nonEmpty(input.activityId, "activityId")}::uuid
      and team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and project_id = ${nonEmpty(input.projectId, "projectId")}
  `;
}

/**
 * The steers the Activity named `activity` by the enclosing query is owed:
 * every steer_requested on it or on the Activity it retries, less what a
 * steer_folded acknowledged. A fragment, so the leg's heartbeat reads them
 * in the same round trip as its lease (dispatch-heartbeat.ts). Unordered:
 * the caller orders by created_at, sequence.
 */
export function undeliveredSteers(sql: Queryable): postgres.Fragment {
  return sql`
    select requested.body_markdown, requested.safe_data ->> 'clientKey' as client_key,
      requested.safe_data -> 'images' as images, requested.created_at, requested.sequence,
      requested.safe_data ->> 'origin' as origin, requested.safe_data ->> 'author' as author,
      requested.safe_data -> 'slack' as slack
    from public.activity_events requested, activity
    where requested.team_id = activity.team_id
      and requested.project_id = activity.project_id
      -- The lineage: the Activity itself and, for a retry, the one it retries.
      and (requested.activity_id = activity.id or requested.activity_id = activity.source_activity_id)
      and requested.safe_data ->> 'event' = 'steer_requested'
      and not exists (
        select 1 from public.activity_events folded
        where folded.activity_id = activity.id
          and folded.safe_data ->> 'event' = 'steer_folded'
          and folded.safe_data ->> 'clientKey' = requested.safe_data ->> 'clientKey'
      )
  `;
}

/** A retried send repeats its clientKey; the agent is owed one delivery. */
export function dedupeSteers(rows: readonly UndeliveredSteerRow[]): OwedSteer[] {
  const seen = new Set<string>();
  const pending: OwedSteer[] = [];
  for (const row of rows) {
    if (!row.body_markdown || seen.has(row.client_key)) continue;
    seen.add(row.client_key);
    pending.push({
      kind: row.origin === "aside" ? "aside" : "message",
      message: row.body_markdown,
      clientKey: row.client_key,
      requestedAtMs: new Date(row.created_at).getTime(),
      images: steerImages(row.images),
      by: row.author ?? null,
      slack: slackLineFacts(row.slack),
    });
  }
  return pending;
}

export async function listUndeliveredActivitySteers(
  sql: Queryable,
  input: { teamId: string; projectId: string; activityId: string },
): Promise<OwedSteer[]> {
  const rows = await sql<UndeliveredSteerRow[]>`
    with activity as (${scopedActivity(sql, input)}), steers as (${undeliveredSteers(sql)})
    select body_markdown, client_key, images, created_at, origin, author, slack from steers
    order by created_at, sequence
  `;
  return dedupeSteers(rows);
}
