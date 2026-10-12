/**
 * Activity creation and event append, as single transactions: the Activity
 * row and its dispatch job identity land atomically, and events take the next
 * sequence under the Activity's row lock. Callers own authorization and the
 * transaction (tenant-store facade).
 */
import { randomUUID } from "node:crypto";

import type postgres from "postgres";
import type { SlackLineFacts } from "@shipbash/contracts/slack-line";
import type { SteerImage } from "@shipbash/contracts/steer-images";

import { commitSha, nonEmpty, safeJsonObject, sha256, timestamp } from "./normalize.ts";
import { ACTIVITY_ROW_COLUMNS, type ActivityEventRow, type ActivityRow } from "./rows.ts";
import { mapActivity, mapActivityEvent } from "./workspace-maps.ts";
import type {
  ActivityEvent,
  ActivitySummary,
  CreateActivityInput,
  TenantActor,
} from "../types.ts";
import { expectRow } from "./expect-row.ts";

export async function createActivityTransaction(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  input: {
    teamId: string;
    projectId: string;
    input: CreateActivityInput;
    sourceActivityId: string | null;
    generation: number;
  },
): Promise<ActivitySummary> {
  const clientKey = nonEmpty(input.input.clientIdempotencyKey, "clientIdempotencyKey");
  const semanticKey = input.input.semanticExecutionKey?.trim() || null;
  const identityHash = sha256(input.input.dispatchIdentity.identityHash, "dispatchIdentity.identityHash");
  const jobExpiresAt = timestamp(input.input.dispatchIdentity.expiresAt, "dispatchIdentity.expiresAt");
  if (new Date(jobExpiresAt) <= new Date()) {
    throw new Error("dispatchIdentity.expiresAt must be in the future.");
  }
  const repositoryId = input.input.repositoryId?.trim() || null;
  const repositoryCommit = commitSha(input.input.repositoryCommitSha, "repositoryCommitSha");
  if (repositoryId) {
    const repositories = await sql`
      select 1 from public.project_repositories
      where id = ${repositoryId}::uuid
        and team_id = ${input.teamId}::uuid
        and project_id = ${input.projectId}
    `;
    if (!repositories[0]) throw new Error("Project Repository not found.");
  }
  const activityId = randomUUID();
  let rows = await sql<ActivityRow[]>`
    insert into public.activities (
      id, team_id, project_id, kind, protected_input, source_proposal_id,
      trigger_source, status, client_idempotency_key, semantic_execution_key,
      source_activity_id, generation, repository_id, repository_commit_sha,
      prompt_contract_version, model_contract, created_by
    ) values (
      ${activityId}, ${input.teamId}::uuid, ${input.projectId}, ${input.input.kind},
      ${input.input.protectedInput?.trim() || null}, ${input.input.sourceProposalId ?? null}::uuid,
      ${input.input.triggerSource}, 'queued',
      ${clientKey}, ${semanticKey}, ${input.sourceActivityId}::uuid, ${input.generation},
      ${repositoryId}::uuid, ${repositoryCommit},
      ${nonEmpty(input.input.promptContractVersion, "promptContractVersion")},
      ${sql.json(safeJsonObject(input.input.modelContract, "modelContract") ?? {})},
      ${actor.userId}::uuid
    )
    on conflict do nothing
    returning ${sql(ACTIVITY_ROW_COLUMNS)}
  `;
  const created = Boolean(rows[0]);
  if (!rows[0]) {
    rows = await sql<ActivityRow[]>`
      select ${sql(ACTIVITY_ROW_COLUMNS)}
      from public.activities
      where team_id = ${input.teamId}::uuid
        and project_id = ${input.projectId}
        and (
          (created_by = ${actor.userId}::uuid and client_idempotency_key = ${clientKey})
          or (${semanticKey}::text is not null and semantic_execution_key = ${semanticKey})
        )
      order by created_at, id
      limit 1
    `;
  }
  if (!rows[0]) throw new Error("Activity idempotency conflict could not be resolved.");
  await writeActivityDispatchIdentity(sql, input, rows[0].id, created, identityHash, jobExpiresAt);
  return mapActivity(rows[0]);
}

/**
 * On the created branch, writes the Activity's dispatch job identity and
 * records the opening message. On an idempotent replay, only verifies the
 * dispatch identity already exists.
 */
async function writeActivityDispatchIdentity(
  sql: postgres.TransactionSql,
  input: { teamId: string; projectId: string; input: CreateActivityInput },
  activityId: string,
  created: boolean,
  identityHash: string,
  jobExpiresAt: string,
): Promise<void> {
  if (created) {
    await sql`
      insert into public.dispatch_jobs (
        team_id, project_id, kind, activity_id, idempotency_key,
        identity_hash, write_scope, status, expires_at
      ) values (
        ${input.teamId}::uuid, ${input.projectId}, 'activity', ${activityId}::uuid,
        ${`activity:${activityId}`}, ${identityHash},
        ${sql.json({
          teamId: input.teamId,
          projectId: input.projectId,
          activityId,
        })},
        'queued', ${jobExpiresAt}
      )
    `;
    await recordInitialMessage(sql, input, activityId);
  } else {
    const jobs = await sql`
      select 1 from public.dispatch_jobs
      where team_id = ${input.teamId}::uuid
        and activity_id = ${activityId}::uuid
        and kind = 'activity'
    `;
    if (!jobs[0]) throw new Error("Idempotent Activity is missing its dispatch identity.");
  }
}

/**
 * A message said to the Activity, as the event its record keeps:
 * steer_requested under its key, with where it came from ("report" when
 * ShipBash composed it, "aside" when it is context, not a request), who said
 * it, the images it carries by reference and where it stands in its Slack
 * thread. The live channel (activity-interaction.ts) and the opening write it
 * alike.
 */
export function steerRequestedEvent(input: {
  message: string;
  clientKey: string;
  displayText?: string | undefined;
  origin?: "report" | "aside";
  author?: string;
  images?: readonly SteerImage[];
  slack?: SlackLineFacts;
}) {
  return {
    kind: "goal",
    label: "Steer",
    bodyMarkdown: input.message,
    safeData: {
      event: "steer_requested",
      clientKey: nonEmpty(input.clientKey, "clientKey"),
      ...(input.displayText ? { displayText: input.displayText } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.author ? { author: input.author } : {}),
      ...(input.images?.length ? { images: input.images } : {}),
      ...(input.slack ? { slack: input.slack } : {}),
    },
  } as const;
}

/**
 * The reader's opening instruction is the run's first chat message: the same
 * steer_requested shape the live channel writes, so the console renders it
 * and the first leg's pending-steer sweep delivers it, after the lines of its
 * chat thread that came before it, as asides (activity-interaction.ts
 * recordAside). Runs only on the created branch — an idempotent replay never
 * re-writes it.
 */
async function recordInitialMessage(
  sql: postgres.TransactionSql,
  input: { teamId: string; projectId: string; input: CreateActivityInput },
  activityId: string,
): Promise<void> {
  const opening = input.input.initialMessage;
  if (!opening) return;
  const scope = { teamId: input.teamId, projectId: input.projectId, activityId };
  // The lines said in its thread before it go first, as asides: context the first turn reads ahead of it.
  for (const line of opening.context ?? []) {
    await appendActivityEventTransaction(sql, { ...scope, ...steerRequestedEvent({ ...line, origin: "aside" }) });
  }
  await appendActivityEventTransaction(sql, {
    ...scope,
    ...steerRequestedEvent({ ...opening, displayText: opening.displayText?.slice(0, 2_000) }),
  });
}

export async function appendActivityEventTransaction(
  sql: postgres.TransactionSql,
  input: {
    teamId: string;
    projectId: string;
    activityId: string;
    kind: ActivityEvent["kind"];
    label: string;
    bodyMarkdown?: string | null | undefined;
    safeData?: Record<string, unknown>;
  },
): Promise<ActivityEvent> {
  const activities = await sql<Array<{ next_event_sequence: number | string; status: ActivitySummary["status"] }>>`
    select next_event_sequence, status
    from public.activities
    where id = ${input.activityId}::uuid
      and team_id = ${input.teamId}::uuid
      and project_id = ${input.projectId}
    for update
  `;
  const activity = activities[0];
  if (!activity) throw new Error("Activity not found.");
  const sequence = Number(activity.next_event_sequence);
  const rows = await sql<ActivityEventRow[]>`
    insert into public.activity_events (
      team_id, project_id, activity_id, sequence, kind,
      label, body_markdown, safe_data
    ) values (
      ${input.teamId}::uuid, ${input.projectId}, ${input.activityId}::uuid,
      ${sequence}, ${input.kind}, ${nonEmpty(input.label, "label")},
      ${input.bodyMarkdown?.trim() || null},
      ${sql.json(safeJsonObject(input.safeData, "safeData") ?? {})}
    )
    returning id, team_id, project_id, activity_id, sequence,
      kind, label, body_markdown, safe_data, created_at
  `;
  await sql`
    update public.activities
    set next_event_sequence = ${sequence + 1}, updated_at = now()
    where id = ${input.activityId}::uuid
  `;
  return mapActivityEvent(expectRow(rows, "activity_events", "insert"));
}
