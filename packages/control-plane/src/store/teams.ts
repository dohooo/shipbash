/**
 * The team aggregate: teams, memberships, invitations, and the identity
 * bootstrap that materializes a profile with its personal team.
 *
 * Membership rules live in shipbash_private SQL functions (bootstrap,
 * create-with-admin, accept, role changes, removal) so RLS and the store
 * share one implementation. Callers own authorization: the tenant store's
 * facade validates inputs and opens the actor-scoped transaction
 * (withActor/withTrustedActor + requireTeamRole) before delegating here.
 */
import type postgres from "postgres";

import { iso, nonEmpty } from "./normalize.ts";
import type {
  CurrentUserRow,
  InvitationRow,
  ProfileIdentityRow,
  TeamMemberRow,
  TeamRow,
} from "./rows.ts";
import type {
  CurrentUser,
  ProfileIdentity,
  Team,
  TeamInvitation,
  TeamMember,
  TeamRole,
} from "../types.ts";

function githubUserId(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function mapInvitation(row: InvitationRow): TeamInvitation {
  return {
    id: row.id,
    teamId: row.team_id,
    invitedGithubUserId: Number(row.invited_github_user_id),
    invitedGithubLogin: row.invited_github_login,
    status: row.status,
    createdBy: row.created_by,
    acceptedBy: row.accepted_by,
    expiresAt: iso(row.expires_at, "team_invitations.expires_at"),
    acceptedAt: iso(row.accepted_at, "team_invitations.accepted_at"),
    revokedAt: iso(row.revoked_at, "team_invitations.revoked_at"),
    createdAt: iso(row.created_at, "team_invitations.created_at"),
  };
}

export async function listTeams(
  sql: postgres.Sql | postgres.TransactionSql,
  userId: string,
): Promise<Team[]> {
  const rows = await sql<TeamRow[]>`
    select team.id, team.slug, team.name, membership.role, team.created_at, team.updated_at
    from public.team_memberships membership
    join public.teams team on team.id = membership.team_id
    where membership.user_id = ${nonEmpty(userId, "actor.userId")}::uuid
    order by lower(team.name), team.id
  `;
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    role: row.role,
    createdAt: iso(row.created_at, "teams.created_at"),
    updatedAt: iso(row.updated_at, "teams.updated_at"),
  }));
}

function profileIdentity(row: ProfileIdentityRow): ProfileIdentity {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    githubUserId: githubUserId(row.github_user_id),
    githubLogin: row.github_login,
    avatarUrl: row.avatar_url,
    email: row.email,
  };
}

/** Brings the signed-in account into existence, or up to date with its identities. */
export async function bootstrapCurrentUser(
  sql: postgres.Sql | postgres.TransactionSql,
  displayName: string | null,
): Promise<void> {
  await sql`select shipbash_private.bootstrap_current_user(${displayName})`;
}

/** Null for an account no sign-in has brought into existence. */
export async function readCurrentUser(
  sql: postgres.Sql | postgres.TransactionSql,
  userId: string,
): Promise<CurrentUser | null> {
  const rows = await sql<CurrentUserRow[]>`
    select profile.user_id, profile.display_name, profile.github_user_id, profile.github_login,
      profile.avatar_url, profile.email, membership.team_id as default_team_id
    from public.user_profiles profile
    left join public.team_memberships membership
      on membership.user_id = profile.user_id and membership.team_id = profile.default_team_id
    where profile.user_id = ${nonEmpty(userId, "actor.userId")}::uuid
  `;
  const row = rows[0];
  return row ? { profile: profileIdentity(row), defaultTeamId: row.default_team_id } : null;
}

export async function updateProfileDisplayName(
  sql: postgres.Sql | postgres.TransactionSql,
  input: { userId: string; displayName: string },
): Promise<ProfileIdentity> {
  const rows = await sql<ProfileIdentityRow[]>`
    update public.user_profiles
    set display_name = ${input.displayName}, updated_at = now()
    where user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
    returning user_id, display_name, github_user_id, github_login, avatar_url, email
  `;
  const profile = rows[0];
  if (!profile) throw new Error("User profile not found.");
  return profileIdentity(profile);
}

export async function createInvitation(
  sql: postgres.TransactionSql,
  input: {
    teamId: string;
    githubUserId: number;
    githubLogin: string;
    tokenHash: string;
    createdBy: string;
    expiresAt: Date | string;
  },
): Promise<TeamInvitation> {
  const rows = await sql<InvitationRow[]>`
    insert into public.team_invitations (
      team_id, invited_github_user_id, invited_github_login,
      token_hash, created_by, expires_at
    ) values (
      ${input.teamId}::uuid, ${input.githubUserId}, ${input.githubLogin}, ${input.tokenHash},
      ${nonEmpty(input.createdBy, "actor.userId")}::uuid, ${input.expiresAt}
    )
    returning id, team_id, invited_github_user_id, invited_github_login,
      status, created_by, accepted_by, expires_at, accepted_at,
      revoked_at, created_at
  `;
  if (!rows[0]) throw new Error("Invitation creation was not authorized.");
  return mapInvitation(rows[0]);
}

export async function revokeInvitation(
  sql: postgres.TransactionSql,
  input: { teamId: string; invitationId: string },
): Promise<TeamInvitation> {
  const rows = await sql<InvitationRow[]>`
    update public.team_invitations
    set status = 'revoked', revoked_at = now()
    where id = ${input.invitationId}::uuid
      and team_id = ${input.teamId}::uuid
      and status = 'pending'
    returning id, team_id, invited_github_user_id, invited_github_login,
      status, created_by, accepted_by, expires_at, accepted_at,
      revoked_at, created_at
  `;
  if (!rows[0]) throw new Error("Pending invitation not found or not authorized.");
  return mapInvitation(rows[0]);
}

export async function listTeamMembers(
  sql: postgres.Sql | postgres.TransactionSql,
  input: { userId: string; teamId: string },
): Promise<TeamMember[]> {
  const rows = await sql<TeamMemberRow[]>`
    select membership.team_id, membership.user_id, membership.role,
      membership.created_at as membership_created_at,
      profile.display_name, profile.github_user_id, profile.github_login,
      profile.avatar_url, profile.email, profile.created_at as profile_created_at,
      profile.updated_at as profile_updated_at
    from public.team_memberships actor_membership
    join public.team_memberships membership
      on membership.team_id = actor_membership.team_id
    join public.user_profiles profile on profile.user_id = membership.user_id
    where actor_membership.team_id = ${input.teamId}::uuid
      and actor_membership.user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
    order by case membership.role when 'admin' then 0 else 1 end,
      lower(profile.display_name), membership.user_id
  `;
  return rows.map((row) => ({
    ...profileIdentity(row),
    teamId: row.team_id,
    role: row.role,
    membershipCreatedAt: iso(row.membership_created_at, "team_memberships.created_at"),
    createdAt: iso(row.profile_created_at, "user_profiles.created_at"),
    updatedAt: iso(row.profile_updated_at, "user_profiles.updated_at"),
  }));
}

export async function listTeamInvitations(
  sql: postgres.Sql | postgres.TransactionSql,
  input: { userId: string; teamId: string },
): Promise<TeamInvitation[]> {
  const rows = await sql<InvitationRow[]>`
    select invitation.id, invitation.team_id, invitation.invited_github_user_id,
      invitation.invited_github_login, invitation.status, invitation.created_by,
      invitation.accepted_by, invitation.expires_at, invitation.accepted_at,
      invitation.revoked_at, invitation.created_at
    from public.team_memberships actor_membership
    join public.team_invitations invitation
      on invitation.team_id = actor_membership.team_id
    where actor_membership.team_id = ${input.teamId}::uuid
      and actor_membership.user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
    order by invitation.created_at desc, invitation.id
  `;
  return rows.map((row) => mapInvitation(row));
}

export async function acceptInvitation(
  sql: postgres.Sql | postgres.TransactionSql,
  tokenHash: string,
): Promise<string> {
  const rows = await sql<Array<{ team_id: string }>>`
    select shipbash_private.accept_team_invitation(${tokenHash}) as team_id
  `;
  if (!rows[0]) throw new Error("Invitation acceptance returned no Team.");
  return rows[0].team_id;
}

export async function setTeamMemberRole(
  sql: postgres.Sql | postgres.TransactionSql,
  input: { teamId: string; userId: string; role: TeamRole },
): Promise<void> {
  await sql`
    select shipbash_private.set_team_member_role(
      ${nonEmpty(input.teamId, "teamId")}::uuid,
      ${nonEmpty(input.userId, "userId")}::uuid,
      ${input.role}
    )
  `;
}

export async function removeTeamMember(
  sql: postgres.Sql | postgres.TransactionSql,
  input: { teamId: string; userId: string },
): Promise<void> {
  await sql`
    select shipbash_private.remove_team_member(
      ${nonEmpty(input.teamId, "teamId")}::uuid,
      ${nonEmpty(input.userId, "userId")}::uuid
    )
  `;
}
