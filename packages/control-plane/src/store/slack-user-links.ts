/**
 * Who a Slack user is on ShipBash, and what that makes them in a workspace.
 *
 * A link is written only by the person it names: signed in to ShipBash, they
 * signed in with Slack as that Slack user and confirmed it (slack-sign-ins.ts).
 * Reading one is the bot's question about a message, so it never takes an
 * actor.
 */
import type postgres from "postgres";

import { nonEmpty } from "./normalize.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/**
 * The Slack user an account last linked in a workspace — whom a message there
 * mentions for it — as a subquery over the caller's columns; null when it
 * linked none.
 */
export function linkedSlackUser(sql: Queryable, account: postgres.Fragment, workspace: postgres.Fragment): postgres.Fragment {
  return sql`(
    select link.slack_user_id from public.slack_user_links link
    where link.user_id = ${account} and link.slack_team_id = ${workspace}
    order by link.linked_at desc limit 1
  )`;
}

/** A Slack user, as the workspace that installed ShipBash names them. */
export interface SlackUser {
  slackTeamId: string;
  slackUserId: string;
}

/** A team that has this workspace connected, and whether the Slack user's account is in it. */
export interface SlackAuthorTeam {
  slug: string;
  name: string;
  member: boolean;
}

/** A live project of a team the Slack user's account is in: one the author may ask about. */
export interface SlackAuthorProject {
  teamId: string;
  teamName: string;
  projectId: string;
  projectName: string;
}

export interface SlackAuthorStanding {
  /** The account the Slack user signed in as, or null when they have not. */
  userId: string | null;
  /** Every team that has the workspace connected; none once Slack has revoked them all. */
  teams: SlackAuthorTeam[];
  projects: SlackAuthorProject[];
}

/**
 * Everything one message's author is in the workspace, in one read: the teams
 * that connected it and, through the author's link, the projects of those
 * they are in. Which of those projects a message is about is the caller's to
 * decide; no channel names one.
 */
export async function selectSlackAuthorStanding(
  sql: Queryable,
  input: SlackUser,
): Promise<SlackAuthorStanding> {
  const rows = await sql<Array<{
    team_id: string;
    team_slug: string;
    team_name: string;
    project_id: string | null;
    project_name: string | null;
    user_id: string | null;
    member: boolean;
  }>>`
    select team.id as team_id, team.slug as team_slug, team.name as team_name,
      project.id as project_id, project.name as project_name, link.user_id,
      membership.user_id is not null as member
    from public.slack_workspaces workspace
    join public.teams team on team.id = workspace.team_id
    left join public.slack_user_links link
      on link.slack_team_id = workspace.slack_team_id
      and link.slack_user_id = ${nonEmpty(input.slackUserId, "slackUserId")}
    left join public.team_memberships membership
      on membership.team_id = team.id and membership.user_id = link.user_id
    -- An archived project is not asked about anywhere, nor is one of a team the author is not in.
    left join public.projects project
      on project.team_id = team.id
      and project.lifecycle_status <> 'archived'
      and membership.user_id is not null
    where workspace.slack_team_id = ${nonEmpty(input.slackTeamId, "slackTeamId")}
      -- A team whose connection Slack revoked is not in this workspace any more.
      and workspace.revoked_at is null
    order by team.name, team.id, project.name, project.id
  `;
  const teams = new Map<string, SlackAuthorTeam>();
  const projects: SlackAuthorProject[] = [];
  for (const row of rows) {
    teams.set(row.team_id, { slug: row.team_slug, name: row.team_name, member: row.member });
    if (row.project_id !== null && row.project_name !== null) {
      projects.push({
        teamId: row.team_id,
        teamName: row.team_name,
        projectId: row.project_id,
        projectName: row.project_name,
      });
    }
  }
  return { userId: rows[0]?.user_id ?? null, teams: [...teams.values()], projects };
}

/** The Slack user is this account from now on; signing in again re-points it. */
export async function upsertSlackUserLink(
  sql: Queryable,
  input: SlackUser & { userId: string },
): Promise<void> {
  await sql`
    insert into public.slack_user_links (slack_team_id, slack_user_id, user_id)
    values (
      ${nonEmpty(input.slackTeamId, "slackTeamId")},
      ${nonEmpty(input.slackUserId, "slackUserId")},
      ${nonEmpty(input.userId, "userId")}::uuid
    )
    on conflict (slack_team_id, slack_user_id)
    do update set user_id = excluded.user_id, linked_at = now()
  `;
}

/** A thread's author as its conversation's team sees them, whatever the channel is bound to now. */
export interface SlackThreadAuthor {
  /** The account they signed in as, or null when they have not. */
  userId: string | null;
  member: boolean;
  team: { slug: string; name: string };
}

export async function selectSlackThreadAuthor(
  sql: Queryable,
  input: SlackUser & { teamId: string },
): Promise<SlackThreadAuthor | null> {
  const rows = await sql<Array<{
    user_id: string | null;
    member: boolean;
    slug: string;
    name: string;
  }>>`
    select link.user_id, membership.user_id is not null as member, team.slug, team.name
    from public.teams team
    left join public.slack_user_links link
      on link.slack_team_id = ${nonEmpty(input.slackTeamId, "slackTeamId")}
      and link.slack_user_id = ${nonEmpty(input.slackUserId, "slackUserId")}
    left join public.team_memberships membership
      on membership.team_id = team.id and membership.user_id = link.user_id
    where team.id = ${nonEmpty(input.teamId, "teamId")}::uuid
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    member: row.member,
    team: { slug: row.slug, name: row.name },
  };
}

/**
 * Of these Slack users, the ones who signed in to ShipBash, and whether each
 * is in the team: what a thread's earlier messages are labelled with.
 */
export async function selectSlackTeamStandings(
  sql: Queryable,
  input: { slackTeamId: string; teamId: string; slackUserIds: readonly string[] },
): Promise<Map<string, { member: boolean }>> {
  if (input.slackUserIds.length === 0) return new Map();
  const rows = await sql<Array<{ slack_user_id: string; member: boolean }>>`
    select link.slack_user_id, membership.user_id is not null as member
    from public.slack_user_links link
    left join public.team_memberships membership
      on membership.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid and membership.user_id = link.user_id
    where link.slack_team_id = ${nonEmpty(input.slackTeamId, "slackTeamId")}
      and link.slack_user_id = any(${sql.array([...input.slackUserIds])}::text[])
  `;
  return new Map(rows.map((row) => [row.slack_user_id, { member: row.member }]));
}
