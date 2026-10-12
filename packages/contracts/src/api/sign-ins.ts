/**
 * The ways into the tested product a Team has saved, and which Projects use
 * them.
 *
 * One rule shapes every schema here: nothing a sign-in keeps secret comes
 * back. A credential goes in on a write and is never echoed, ciphertext has no
 * field at all, and the only thing the read model says about the sealing key
 * is `keyAvailable` — false when the environment no longer carries the key
 * that sealed the row, which the page shows as paused rather than as a Team
 * that saved nothing.
 */
import { z } from "zod";

import {
	PUBLIC_TEAM_SIGN_INS_FAILURE_REASON_VALUES,
	PUBLIC_TEAM_SIGN_INS_METHOD_VALUES,
	PUBLIC_TEAM_SIGN_INS_STATUS_VALUES,
} from "../runtime/generated/db-vocabularies.mjs";
import { defineApiContract } from "./core.ts";
import {
	idSchema,
	nonEmptyTextSchema,
	projectParamsSchema,
	teamParamsSchema,
	timestampSchema,
} from "./primitives.ts";

export const teamSignInMethodSchema = z.enum(PUBLIC_TEAM_SIGN_INS_METHOD_VALUES);
export const teamSignInStatusSchema = z.enum(PUBLIC_TEAM_SIGN_INS_STATUS_VALUES);
export const teamSignInFailureReasonSchema = z.enum(
	PUBLIC_TEAM_SIGN_INS_FAILURE_REASON_VALUES,
);

export const teamSignInViewSchema = z.object({
	id: idSchema,
	teamId: idSchema,
	method: teamSignInMethodSchema,
	/** The account the verification leg read back; null until one has landed. */
	label: z.string().nullable(),
	loginUrl: z.string().nullable(),
	status: teamSignInStatusSchema,
	failureReason: teamSignInFailureReasonSchema.nullable(),
	consecutiveFailures: z.number().int().nonnegative(),
	/** False once the key that sealed this row is gone from the environment. */
	keyAvailable: z.boolean(),
	lastVerifiedAt: timestampSchema.nullable(),
	createdAt: timestampSchema,
	updatedAt: timestampSchema,
});

/** A way in as a Project that bound it sees it: the Team's row, and whether this Project's verification runs sign in with it. */
export const boundSignInViewSchema = teamSignInViewSchema.extend({
	forRuns: z.boolean(),
});

export const projectSignInBindingSchema = z.object({
	projectId: idSchema,
	signInId: idSchema,
	teamId: idSchema,
	createdAt: timestampSchema,
});

/** Write-only: the password lane's material, accepted and never returned. */
export const teamSignInCredentialSchema = z.object({
	email: nonEmptyTextSchema(320),
	password: nonEmptyTextSchema(1_024),
	totpSecret: nonEmptyTextSchema(256).nullable().optional(),
});

const loginUrlSchema = z.string().trim().min(1).max(2_048).pipe(z.url());

/** A sign-in's id is a database uuid, so a path that is not one is a bad path. */
const signInIdSchema = z.uuid();

export const teamSignInParamsSchema = teamParamsSchema.extend({
	signInId: signInIdSchema,
});
export const projectSignInParamsSchema = projectParamsSchema.extend({
	signInId: signInIdSchema,
});

export const teamSignInsContract = defineApiContract({
	id: "signIns.listForTeam",
	method: "GET",
	path: "/api/teams/:teamId/sign-ins",
	params: teamParamsSchema,
	query: null,
	body: null,
	response: z.object({ signIns: z.array(teamSignInViewSchema) }),
	successStatuses: [200],
});

export const createTeamSignInContract = defineApiContract({
	id: "signIns.create",
	method: "POST",
	path: "/api/teams/:teamId/sign-ins",
	params: teamParamsSchema,
	query: null,
	body: z.object({
		method: teamSignInMethodSchema,
		loginUrl: loginUrlSchema.nullable().optional(),
		/** Only an email_password sign-in carries one; the store refuses the rest. */
		credential: teamSignInCredentialSchema.optional(),
	}),
	response: z.object({ signIn: teamSignInViewSchema }),
	successStatuses: [201],
});

export const deleteTeamSignInContract = defineApiContract({
	id: "signIns.delete",
	method: "DELETE",
	path: "/api/teams/:teamId/sign-ins/:signInId",
	params: teamSignInParamsSchema,
	query: null,
	body: null,
	response: z.undefined(),
	successStatuses: [204],
});

export const projectSignInsContract = defineApiContract({
	id: "signIns.listForProject",
	method: "GET",
	path: "/api/projects/:projectId/sign-ins",
	params: projectParamsSchema,
	query: null,
	body: null,
	response: z.object({ signIns: z.array(boundSignInViewSchema) }),
	successStatuses: [200],
});

export const bindProjectSignInContract = defineApiContract({
	id: "signIns.bind",
	method: "POST",
	path: "/api/projects/:projectId/sign-ins",
	params: projectParamsSchema,
	query: null,
	body: z.object({ signInId: signInIdSchema }),
	response: z.object({ binding: projectSignInBindingSchema }),
	successStatuses: [201],
});

export const unbindProjectSignInContract = defineApiContract({
	id: "signIns.unbind",
	method: "DELETE",
	path: "/api/projects/:projectId/sign-ins/:signInId",
	params: projectSignInParamsSchema,
	query: null,
	body: null,
	response: z.undefined(),
	successStatuses: [204],
});

/**
 * Moves this Project's verification runs onto one of its ready ways in, and
 * starts them from the session that way in keeps. The first way in a Project
 * proves becomes it on its own; this is the owner switching to another.
 */
export const chooseProjectRunSignInContract = defineApiContract({
	id: "signIns.chooseForRuns",
	method: "PUT",
	path: "/api/projects/:projectId/sign-ins/:signInId/runs",
	params: projectSignInParamsSchema,
	query: null,
	body: null,
	response: z.undefined(),
	successStatuses: [204],
});
