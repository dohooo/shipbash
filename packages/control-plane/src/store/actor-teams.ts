/**
 * Actor facet — Teams: membership, profile, and invitation doors. Every
 * method proves the caller's team role through the spine before the
 * src/store/teams.ts aggregate runs.
 */
import { ActorWaitlistStore } from "./actor-waitlist.ts";
import type {
  CurrentUser,
  ProfileIdentity,
  Team,
  TeamInvitation,
  TeamMember,
  TeamRole,
  TenantActor,
} from "../types.ts";
import { nonEmpty, positiveInteger, sha256, timestamp } from "./normalize.ts";
import { type RunAllowance, type RunDay, readRunAllowance, readRunDays } from "./run-quota.ts";
import {
  listTeamAccessRequests,
  readTeamAccessGate,
  requestTeamAccess,
  resolveTeamAccessRequest,
  type TeamAccessGate,
  type TeamAccessRequest,
} from "./team-access-requests.ts";
import {
  acceptInvitation,
  bootstrapCurrentUser,
  readCurrentUser,
  createInvitation,
  listTeamInvitations,
  listTeamMembers,
  listTeams,
  removeTeamMember,
  revokeInvitation,
  setTeamMemberRole,
  updateProfileDisplayName,
} from "./teams.ts";

export class ActorTeamsStore extends ActorWaitlistStore {
  async listTeams(actor: TenantActor): Promise<Team[]> {
    return this.withActor(actor, async (sql) => listTeams(sql, actor.userId));
  }

  async bootstrapCurrentUser(
    actor: TenantActor,
    displayNameOverride: string | null = null,
  ): Promise<CurrentUser> {
    const normalizedDisplayName = displayNameOverride?.trim() || null;
    if (normalizedDisplayName && normalizedDisplayName.length > 120) {
      throw new Error("displayNameOverride must contain at most 120 characters.");
    }
    await this.withActor(actor, async (sql) => bootstrapCurrentUser(sql, normalizedDisplayName));
    const current = await this.readCurrentUser(actor);
    if (!current) throw new Error("User bootstrap left no profile.");
    return current;
  }

  /**
   * Trusted, and only ever the caller's own row: the default team is a column
   * no browser role reads, so a teammate's never reaches anyone.
   */
  async readCurrentUser(actor: TenantActor): Promise<CurrentUser | null> {
    return this.withTrustedActor(actor, async (sql) => readCurrentUser(sql, actor.userId));
  }

  async updateProfileDisplayName(
    actor: TenantActor,
    displayName: string,
  ): Promise<ProfileIdentity> {
    const normalizedName = nonEmpty(displayName, "displayName");
    if (normalizedName.length > 120) throw new Error("displayName exceeds 120 characters.");
    return this.withActor(actor, async (sql) => updateProfileDisplayName(sql, {
      userId: actor.userId,
      displayName: normalizedName,
    }));
  }

  async createInvitation(
    actor: TenantActor,
    teamId: string,
    input: {
      githubUserId: number;
      githubLogin: string;
      tokenHash: string;
      expiresAt: string;
    },
  ): Promise<TeamInvitation> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const githubUserId = positiveInteger(input.githubUserId, "githubUserId");
    const githubLogin = nonEmpty(input.githubLogin, "githubLogin");
    const tokenHash = sha256(input.tokenHash, "tokenHash");
    const expiresAt = timestamp(input.expiresAt, "expiresAt");
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      return createInvitation(sql, {
        teamId: scopedTeamId,
        githubUserId,
        githubLogin,
        tokenHash,
        createdBy: actor.userId,
        expiresAt,
      });
    });
  }

  async revokeInvitation(
    actor: TenantActor,
    teamId: string,
    invitationId: string,
  ): Promise<TeamInvitation> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedInvitationId = nonEmpty(invitationId, "invitationId");
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      return revokeInvitation(sql, { teamId: scopedTeamId, invitationId: scopedInvitationId });
    });
  }

  async listTeamMembers(actor: TenantActor, teamId: string): Promise<TeamMember[]> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    return this.withActor(actor, async (sql) => listTeamMembers(sql, {
      userId: actor.userId,
      teamId: scopedTeamId,
    }));
  }

  /** The team's Runs this month against its quota; null for a team the actor is not in. */
  async readRunAllowance(actor: TenantActor, teamId: string): Promise<RunAllowance | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    return this.withActor(actor, async (sql) => readRunAllowance(sql, scopedTeamId, this.runQuota));
  }

  /** Null for a team the actor cannot see. */
  async readRunDays(actor: TenantActor, teamId: string): Promise<RunDay[] | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    return this.withActor(actor, async (sql) => {
      const [team] = await sql`select 1 from public.teams where id = ${scopedTeamId}::uuid`;
      return team ? readRunDays(sql, scopedTeamId) : null;
    });
  }

  async listTeamInvitations(actor: TenantActor, teamId: string): Promise<TeamInvitation[]> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    return this.withActor(actor, async (sql) => listTeamInvitations(sql, {
      userId: actor.userId,
      teamId: scopedTeamId,
    }));
  }

  async acceptInvitation(actor: TenantActor, tokenHash: string): Promise<string> {
    const normalizedHash = tokenHash.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalizedHash)) {
      throw new Error("tokenHash must be a lowercase SHA-256 hash.");
    }
    return this.withActor(actor, async (sql) => acceptInvitation(sql, normalizedHash));
  }

  async setTeamMemberRole(
    actor: TenantActor,
    teamId: string,
    userId: string,
    role: TeamRole,
  ): Promise<void> {
    await this.withActor(actor, async (sql) => {
      await setTeamMemberRole(sql, { teamId, userId, role });
    });
  }

  async removeTeamMember(actor: TenantActor, teamId: string, userId: string): Promise<void> {
    await this.withActor(actor, async (sql) => {
      await removeTeamMember(sql, { teamId, userId });
    });
  }

  /**
   * The gate doors are trusted rather than actor-scoped on purpose: the reader
   * standing at them is outside the Team, so RLS would hide the very Team the
   * answer is about. What they disclose is bounded by the read itself.
   */
  async readTeamAccessGate(actor: TenantActor, team: string): Promise<TeamAccessGate> {
    const address = nonEmpty(team, "team");
    return this.withTrustedActor(actor, async (sql) => readTeamAccessGate(sql, {
      address,
      userId: actor.userId,
    }));
  }

  async requestTeamAccess(actor: TenantActor, team: string): Promise<string> {
    const address = nonEmpty(team, "team");
    return this.withTrustedActor(actor, async (sql) => requestTeamAccess(sql, {
      address,
      userId: actor.userId,
    }));
  }

  async listTeamAccessRequests(
    actor: TenantActor,
    teamId: string,
  ): Promise<TeamAccessRequest[]> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    return this.withTrustedActor(actor, async (sql) => listTeamAccessRequests(sql, {
      teamId: scopedTeamId,
      userId: actor.userId,
    }));
  }

  async resolveTeamAccessRequest(
    actor: TenantActor,
    teamId: string,
    requestId: string,
    decision: "approve" | "decline",
  ): Promise<void> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedRequestId = nonEmpty(requestId, "requestId");
    await this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      await resolveTeamAccessRequest(sql, {
        teamId: scopedTeamId,
        requestId: scopedRequestId,
        decision,
        decidedBy: actor.userId,
      });
    });
  }
}
