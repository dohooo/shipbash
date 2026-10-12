/**
 * Asking to be let into a Team, and answering that ask.
 *
 * The gate routes are the second place the API speaks the address vocabulary
 * — a slug or an id — because the reader standing at them has no session
 * scope to resolve the Team from. Everything they answer is the minimum a
 * stranger needs to ask for access: the Team's name, the display names of the
 * people who can grant it, and whether they already asked. Never an email
 * address, never a project, never a run.
 */
import { z } from "zod";

import { defineApiContract } from "./core.ts";
import { idSchema, teamParamsSchema, timestampSchema } from "./primitives.ts";

const teamAddressParamsSchema = z.object({ team: idSchema });

/** A pending request as the Team's admins read it on Members. */
export const teamAccessRequestSchema = z.object({
	id: idSchema,
	teamId: idSchema,
	/** How the admin recognises the requester — `@login`, or the email of an account without one; the requester never sees theirs back. */
	requester: z.string(),
	createdAt: timestampSchema,
});

const teamAccessGateSchema = z.discriminatedUnion("access", [
	z.object({ access: z.literal("member") }),
	z.object({
		access: z.literal("outsider"),
		teamName: z.string(),
		/** Display names only. An email address must never reach a non-member. */
		adminNames: z.array(z.string()),
		/** When this reader's open request was filed; null while they have none. */
		requestedAt: timestampSchema.nullable(),
	}),
]);

export const teamAccessGateContract = defineApiContract({
	id: "teamAccess.gate",
	method: "GET",
	path: "/api/team-access/:team",
	params: teamAddressParamsSchema,
	query: null,
	body: null,
	response: teamAccessGateSchema,
	successStatuses: [200],
});

/**
 * 200 rather than 201: one pending request per person per Team, so asking
 * twice answers with the request already open instead of filing another.
 */
export const requestTeamAccessContract = defineApiContract({
	id: "teamAccess.request",
	method: "POST",
	path: "/api/team-access/:team",
	params: teamAddressParamsSchema,
	query: null,
	body: null,
	response: z.object({ requestedAt: timestampSchema }),
	successStatuses: [200],
});

const teamAccessRequestParamsSchema = teamParamsSchema.extend({
	requestId: idSchema,
});

export const resolveTeamAccessRequestContract = defineApiContract({
	id: "teamAccess.resolve",
	method: "PATCH",
	path: "/api/teams/:teamId/access-requests/:requestId",
	params: teamAccessRequestParamsSchema,
	query: null,
	body: z.object({ decision: z.enum(["approve", "decline"]) }),
	response: z.undefined(),
	successStatuses: [204],
});
