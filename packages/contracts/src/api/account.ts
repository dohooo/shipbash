import { z } from "zod";

import {
	PUBLIC_TEAM_INVITATIONS_STATUS_VALUES,
	PUBLIC_TEAM_MEMBERSHIPS_ROLE_VALUES,
} from "../runtime/generated/db-vocabularies.mjs";
import { defineApiContract } from "./core.ts";
import {
	idSchema,
	nonEmptyTextSchema,
	teamParamsSchema,
	timestampSchema,
} from "./primitives.ts";
import { projectViewSchema } from "./projects.ts";
import { teamAccessRequestSchema } from "./team-access.ts";

/** Who an account is to its teammates: a GitHub login, an email, or both. */
const profileSchema = z.object({
	userId: idSchema,
	displayName: z.string(),
	githubUserId: z.number().int().positive().nullable(),
	githubLogin: z.string().nullable(),
	avatarUrl: z.string().nullable(),
	email: z.string().nullable(),
});

const teamRoleSchema = z.enum(PUBLIC_TEAM_MEMBERSHIPS_ROLE_VALUES);
const teamSchema = z.object({
	id: idSchema,
	slug: z.string(),
	name: z.string(),
	role: teamRoleSchema,
	createdAt: timestampSchema,
	updatedAt: timestampSchema,
});

const invitationSchema = z.object({
	id: idSchema,
	teamId: idSchema,
	invitedGithubUserId: z.number().int().positive(),
	invitedGithubLogin: z.string(),
	status: z.enum(PUBLIC_TEAM_INVITATIONS_STATUS_VALUES),
	createdBy: idSchema,
	acceptedBy: idSchema.nullable(),
	expiresAt: timestampSchema,
	acceptedAt: timestampSchema.nullable(),
	revokedAt: timestampSchema.nullable(),
	createdAt: timestampSchema,
});

const memberSchema = profileSchema.extend({
	teamId: idSchema,
	role: teamRoleSchema,
	membershipCreatedAt: timestampSchema,
	createdAt: timestampSchema,
	updatedAt: timestampSchema,
});

/** Called once a sign-in completes: the account, its personal team and its company team exist after it. */
export const startSessionContract = defineApiContract({
	id: "account.startSession",
	method: "POST",
	path: "/api/session",
	params: null,
	query: null,
	body: null,
	response: z.undefined(),
	successStatuses: [204],
});

export const sessionContract = defineApiContract({
	id: "account.session",
	method: "GET",
	path: "/api/session",
	params: null,
	query: z.object({
		team: z.preprocess(
			(value) => (value === "" ? undefined : value),
			idSchema.optional(),
		),
	}),
	body: null,
	response: z.object({
		profile: profileSchema,
		teams: z.array(teamSchema),
		activeTeamId: idSchema,
		projects: z.array(projectViewSchema),
		/** The optional integrations this deployment serves; the console offers only these. */
		integrations: z.object({ slack: z.boolean(), github: z.boolean() }),
	}),
	successStatuses: [200],
});

export const acceptInvitationContract = defineApiContract({
	id: "account.acceptInvitation",
	method: "POST",
	path: "/api/invitations/accept",
	params: null,
	query: null,
	body: z.object({ token: nonEmptyTextSchema(128) }),
	response: z.object({ teamId: idSchema }),
	successStatuses: [200],
});

export const updateProfileContract = defineApiContract({
	id: "account.updateProfile",
	method: "PATCH",
	path: "/api/profile",
	params: null,
	query: null,
	body: z.object({ displayName: nonEmptyTextSchema(120) }),
	response: z.object({ profile: profileSchema }),
	successStatuses: [200],
});

export const teamMembersContract = defineApiContract({
	id: "account.teamMembers",
	method: "GET",
	path: "/api/teams/:teamId/members",
	params: teamParamsSchema,
	query: null,
	body: null,
	response: z.object({
		members: z.array(memberSchema),
		invitations: z.array(invitationSchema),
		/** Who asked to be let in. Empty for anyone who could not grant it. */
		accessRequests: z.array(teamAccessRequestSchema),
	}),
	successStatuses: [200],
});

/**
 * The Runs the team's verification runs counted since the start of this UTC
 * month, against the monthly quota that refuses a new one; null is no limit.
 */
export const teamRunAllowanceContract = defineApiContract({
	id: "account.teamRunAllowance",
	method: "GET",
	path: "/api/teams/:teamId/run-allowance",
	params: teamParamsSchema,
	query: null,
	body: null,
	response: z.object({
		used: z.number().int().nonnegative(),
		quota: z.number().int().nonnegative().nullable(),
	}),
	successStatuses: [200],
});

/**
 * The team's Runs per UTC day and project, counted like the monthly allowance
 * (by the day a run ended), from the Sunday that starts the year-long grid of
 * weeks through today. Only days and projects that used a Run are listed.
 */
export const teamRunDaysContract = defineApiContract({
	id: "account.teamRunDays",
	method: "GET",
	path: "/api/teams/:teamId/run-days",
	params: teamParamsSchema,
	query: null,
	body: null,
	response: z.object({
		days: z.array(
			z.object({
				day: z.iso.date(),
				projectId: z.string(),
				runs: z.number().int().positive(),
			}),
		),
	}),
	successStatuses: [200],
});

export const createInvitationContract = defineApiContract({
	id: "account.createInvitation",
	method: "POST",
	path: "/api/teams/:teamId/invitations",
	params: teamParamsSchema,
	query: null,
	body: z.object({ githubLogin: nonEmptyTextSchema(39) }),
	response: z.object({ invitation: invitationSchema, inviteUrl: z.string() }),
	successStatuses: [201],
});

const teamInvitationParamsSchema = teamParamsSchema.extend({
	invitationId: idSchema,
});
export const revokeInvitationContract = defineApiContract({
	id: "account.revokeInvitation",
	method: "DELETE",
	path: "/api/teams/:teamId/invitations/:invitationId",
	params: teamInvitationParamsSchema,
	query: null,
	body: null,
	response: z.undefined(),
	successStatuses: [204],
});

const teamMemberParamsSchema = teamParamsSchema.extend({ userId: idSchema });
export const updateTeamMemberContract = defineApiContract({
	id: "account.updateTeamMember",
	method: "PATCH",
	path: "/api/teams/:teamId/members/:userId",
	params: teamMemberParamsSchema,
	query: null,
	body: z.object({ role: teamRoleSchema }),
	response: z.object({ member: memberSchema.optional() }),
	successStatuses: [200],
});

export const removeTeamMemberContract = defineApiContract({
	id: "account.removeTeamMember",
	method: "DELETE",
	path: "/api/teams/:teamId/members/:userId",
	params: teamMemberParamsSchema,
	query: null,
	body: null,
	response: z.undefined(),
	successStatuses: [204],
});
