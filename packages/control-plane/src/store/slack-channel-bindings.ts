/**
 * Where each project's failures are announced: a route is one project and one
 * channel, and a project may have several, as a channel may serve several
 * projects.
 *
 * Two writes, because there are two events. Binding a channel is an admin
 * adding it, once Slack has said it can be posted in, and is the only thing
 * that decides where alerts go; recording a delivery result is how one message
 * to the channel a binding already names ended, and a test or an alert only
 * ever does that.
 *
 * These functions are authorization-blind, like their neighbours: the caller
 * has established the actor's Team role, and every statement is additionally
 * bound to the team.
 */
import type { SlackDeliveryError } from "@shipbash/contracts/database-contract-types";
import type postgres from "postgres";

import type { SlackChannel } from "../slack-channels.ts";
import { iso, nonEmpty } from "./normalize.ts";
import { closeSlackAlertChannelThreads } from "./slack-alert-threads.ts";
import type { SelectedRow, Timestamp } from "./table-rows.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

type BindingRow = SelectedRow<
  "slack_channel_bindings",
  "project_id" | "workspace_id" | "channel_id" | "channel_name" | "is_private",
  {
    project_name: string;
    last_delivered_at: Timestamp | null;
    delivery_error: SlackDeliveryError | null;
    unannounced_failures: number;
  }
>;

/** One project's route into one channel, as the routing table draws it. */
export interface SlackChannelBinding {
  projectId: string;
  /** Carried, not looked up: an archived project keeps its row and its name. */
  projectName: string;
  channel: SlackChannel;
  /** When a message last really arrived; null until a test or an alert does. */
  lastDeliveredAt: string | null;
  deliveryError: SlackDeliveryError | null;
  /** Failures this route could not announce since its current silence began. */
  unannouncedFailures: number;
}

/** A channel an admin added to the ones a project alerts into. */
export interface SlackChannelBindingInput {
  teamId: string;
  workspaceId: string;
  projectId: string;
  channel: SlackChannel;
  boundBy: string;
}

/** How one message to the binding's own channel ended. */
export interface SlackDeliveryResult {
  teamId: string;
  projectId: string;
  channelId: string;
  error: SlackDeliveryError | null;
}

function mapBinding(row: BindingRow): SlackChannelBinding {
  return {
    projectId: row.project_id,
    projectName: row.project_name,
    channel: { id: row.channel_id, name: row.channel_name, isPrivate: row.is_private },
    lastDeliveredAt: iso(row.last_delivered_at, "slack_channel_bindings.last_delivered_at"),
    deliveryError: row.delivery_error,
    unannouncedFailures: Number(row.unannounced_failures),
  };
}

/**
 * Every route the team has, grouped by the workspace whose card draws it,
 * each carrying what its own silence has cost: only the outbox rows of its
 * channel count.
 *
 * The count is a correlated subquery rather than a read of its own because
 * every surface that names a silence names its loss in the same breath, and a
 * second round trip would let the two disagree. Its window is the silence's
 * own: a revoked workspace stopped everything, so everything settled since
 * `revoked_at` counts; a channel that is refusing stopped only itself, so only
 * refused deliveries count, and only since a message last reached it. Nothing
 * resets either window by hand — reconnecting clears `revoked_at` and a
 * delivery moves `last_delivered_at`, and the number falls away with them.
 */
export async function selectSlackChannelBindings(
  sql: Queryable,
  teamId: string,
): Promise<Map<string, SlackChannelBinding[]>> {
  const rows = await sql<BindingRow[]>`
    select binding.project_id, project.name as project_name, binding.workspace_id,
      binding.channel_id, binding.channel_name, binding.is_private,
      binding.last_delivered_at, binding.delivery_error,
      (
        select count(*)
        from public.slack_alert_outbox outbox
        where outbox.team_id = binding.team_id
          and outbox.project_id = binding.project_id
          and outbox.channel_id = binding.channel_id
          and outbox.status = 'unannounced'
          -- A run nobody could verify is not a failure, and counting it as one
          -- would inflate the very number that is meant to be trusted.
          and outbox.alert_kind = 'failed'
          and outbox.settled_at >= case
            when workspace.revoked_at is not null then workspace.revoked_at
            else coalesce(binding.last_delivered_at, binding.bound_at)
          end
          and (
            workspace.revoked_at is not null
            or outbox.unannounced_reason = 'delivery_refused'
          )
      ) as unannounced_failures
    from public.slack_channel_bindings binding
    join public.projects project on project.id = binding.project_id
    join public.slack_workspaces workspace on workspace.id = binding.workspace_id
    where binding.team_id = ${nonEmpty(teamId, "teamId")}::uuid
    order by project.name, binding.project_id, binding.channel_name, binding.channel_id
  `;
  const grouped = new Map<string, SlackChannelBinding[]>();
  for (const row of rows) {
    const bindings = grouped.get(row.workspace_id) ?? [];
    bindings.push(mapBinding(row));
    grouped.set(row.workspace_id, bindings);
  }
  return grouped;
}

/**
 * Adds the channel an admin chose to the ones the project alerts into, and
 * says whether the route is new. Only that choice writes this: a test or an
 * alert delivered somewhere is not a decision about where alerts go.
 *
 * A route the project already has keeps who chose it, when, and how it has
 * delivered, and takes what Slack calls the channel now.
 */
export async function bindSlackChannel(
  sql: Queryable,
  input: SlackChannelBindingInput,
): Promise<boolean> {
  const written = await sql<Array<{ added: boolean }>>`
    insert into public.slack_channel_bindings (
      project_id, team_id, workspace_id, channel_id, channel_name, is_private, bound_by
    )
    -- The row is sourced from the workspace and the project rather than from
    -- the caller's ids, so a binding across two teams cannot be written even
    -- if one were asked for.
    select project.id, workspace.team_id, workspace.id, ${nonEmpty(input.channel.id, "channel.id")},
      ${nonEmpty(input.channel.name, "channel.name")}, ${input.channel.isPrivate},
      ${nonEmpty(input.boundBy, "boundBy")}::uuid
    from public.slack_workspaces workspace
    join public.projects project
      on project.id = ${nonEmpty(input.projectId, "projectId")} and project.team_id = workspace.team_id
    where workspace.id = ${nonEmpty(input.workspaceId, "workspaceId")}::uuid
      and workspace.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
    on conflict (project_id, channel_id) do update
    set channel_name = excluded.channel_name, is_private = excluded.is_private
    -- xmax is 0 only on a row this statement inserted.
    returning xmax = 0 as added
  `;
  // Nothing written means the team has no such workspace or project, and a
  // save that wrote nothing must not answer as one that did.
  const row = written[0];
  if (!row) throw new Error("The project was not found.");
  return row.added;
}

/**
 * How one message to the channel a binding already names ended, and the only
 * statement that records one. Update-only on purpose: a test or an alert must
 * never create or re-point a binding.
 */
export async function recordSlackDeliveryResult(
  sql: Queryable,
  result: SlackDeliveryResult,
): Promise<void> {
  await sql`
    update public.slack_channel_bindings
    set delivery_error = ${result.error},
        last_delivered_at = case when ${result.error}::text is null then now() else last_delivered_at end
    where team_id = ${nonEmpty(result.teamId, "teamId")}::uuid
      and project_id = ${nonEmpty(result.projectId, "projectId")}
      and channel_id = ${nonEmpty(result.channelId, "channelId")}
  `;
}

/** Whether the team has this project, asked before Slack is: a channel is never joined for nothing. */
export async function selectSlackBindableProject(
  sql: Queryable,
  input: { teamId: string; projectId: string },
): Promise<boolean> {
  const rows = await sql`
    select 1 from public.projects
    where id = ${nonEmpty(input.projectId, "projectId")}
      and team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
  `;
  return rows.length > 0;
}

/**
 * The project stops alerting into this channel, and its threads there close.
 * Its other channels and the workspace are untouched.
 */
export async function deleteSlackChannelBinding(
  sql: Queryable,
  input: { teamId: string; projectId: string; channelId: string },
): Promise<void> {
  await sql`
    delete from public.slack_channel_bindings
    where team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and project_id = ${nonEmpty(input.projectId, "projectId")}
      and channel_id = ${nonEmpty(input.channelId, "channelId")}
  `;
  await closeSlackAlertChannelThreads(sql, input);
}

/** One channel a project's alerts go to, and whether the workspace still delivers. */
export interface SlackChannelRoute {
  workspaceId: string;
  channelId: string;
  workspaceRevoked: boolean;
}

/**
 * The route one finished run's alert into this channel would take, or null
 * when the project no longer alerts there. The workspace's revocation
 * travels with it rather than being looked up after: a workspace Slack has
 * stopped honouring is why nothing arrives, and the sender has to say so on
 * the outbox row instead of attempting a call on a token it knows is dead.
 */
export async function selectSlackAlertRoute(
  sql: Queryable,
  input: { teamId: string; projectId: string; channelId: string },
): Promise<SlackChannelRoute | null> {
  const rows = await sql<Array<{ workspace_id: string; channel_id: string; revoked_at: Timestamp | null }>>`
    select binding.workspace_id, binding.channel_id, workspace.revoked_at
    from public.slack_channel_bindings binding
    join public.slack_workspaces workspace on workspace.id = binding.workspace_id
    where binding.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and binding.project_id = ${nonEmpty(input.projectId, "projectId")}
      and binding.channel_id = ${nonEmpty(input.channelId, "channelId")}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    workspaceRevoked: row.revoked_at !== null,
  };
}

/** Where a test message goes, and what it has to name. */
export interface SlackTestSubject {
  workspaceId: string;
  channelId: string;
  projectName: string;
  /** The person who asked for it, as their team knows them. */
  sentBy: string;
}

/**
 * One of the project's channels and what the test message says about it, or
 * null when the project does not alert there: a test only ever reaches a
 * channel the project is bound to.
 */
export async function selectSlackTestSubject(
  sql: Queryable,
  input: { teamId: string; projectId: string; channelId: string; userId: string },
): Promise<SlackTestSubject | null> {
  const rows = await sql<Array<{
    workspace_id: string;
    channel_id: string;
    project_name: string;
    display_name: string | null;
  }>>`
    select binding.workspace_id, binding.channel_id, project.name as project_name,
      profile.display_name
    from public.slack_channel_bindings binding
    join public.projects project on project.id = binding.project_id
    left join public.user_profiles profile
      on profile.user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
    where binding.project_id = ${nonEmpty(input.projectId, "projectId")}
      and binding.channel_id = ${nonEmpty(input.channelId, "channelId")}
      and binding.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    projectName: row.project_name,
    sentBy: row.display_name ?? "A ShipBash admin",
  };
}
