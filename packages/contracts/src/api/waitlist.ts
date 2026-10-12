/**
 * The waiting list: what a reader may say at the wall, and what the internal
 * lane behind it reads.
 *
 * The two reader routes answer only what the reader themselves told us — the
 * address, the site, and when they asked. `state` is ours, never theirs: a
 * shelved reader and a waiting reader see the identical page, so it must not
 * be reachable from the reader's side at all, and it is absent from the
 * standing shape rather than nulled out in it.
 *
 * The internal routes are the other half, and they carry no actor: there is no
 * account behind the shared password the route checks, so nothing here is
 * scoped to a Team. The one thing they change on a Team is its monthly Run
 * quota.
 */
import { z } from "zod";

import { PUBLIC_WAITLIST_REQUESTS_STATE_VALUES } from "../runtime/generated/db-vocabularies.mjs";
import { defineApiContract } from "./core.ts";
import { idSchema, nonEmptyTextSchema, timestampSchema } from "./primitives.ts";

/** The account's own ask, given back. Null while they have not made one. */
const waitlistStandingSchema = z.object({
	request: z
		.object({
			email: z.string(),
			/** The normalized absolute URL the server stored. */
			site: z.string(),
			requestedAt: timestampSchema,
		})
		.nullable(),
});

export const waitlistStandingContract = defineApiContract({
	id: "waitlist.standing",
	method: "GET",
	path: "/api/waitlist",
	params: null,
	query: null,
	body: null,
	response: waitlistStandingSchema,
	successStatuses: [200],
});

/**
 * 201 rather than 200: one ask per account, so a second one is a conflict
 * rather than the first ask read back.
 */
export const joinWaitlistContract = defineApiContract({
	id: "waitlist.join",
	method: "POST",
	path: "/api/waitlist",
	params: null,
	query: null,
	// `site` is only length-bounded here. Whether it is an address we can reach
	// is the server's judgement, answered as 422 INVALID_SITE, because the
	// reader must get the same verdict with scripting off.
	body: z.object({
		email: nonEmptyTextSchema(320),
		site: nonEmptyTextSchema(2_000),
	}),
	response: z.object({
		email: z.string(),
		site: z.string(),
		requestedAt: timestampSchema,
	}),
	successStatuses: [201],
});

const waitlistRequestSchema = z.object({
	userId: idSchema,
	email: z.string(),
	site: z.string(),
	requestedAt: timestampSchema,
	state: z.enum(PUBLIC_WAITLIST_REQUESTS_STATE_VALUES),
	admittedAt: timestampSchema.nullable(),
});

export const listWaitlistRequestsContract = defineApiContract({
	id: "waitlist.internal.list",
	method: "GET",
	path: "/api/waitlist/internal",
	params: null,
	query: null,
	body: null,
	response: z.object({ requests: z.array(waitlistRequestSchema) }),
	successStatuses: [200],
});

export const decideWaitlistRequestContract = defineApiContract({
	id: "waitlist.internal.decide",
	method: "PATCH",
	path: "/api/waitlist/internal/:userId",
	params: z.object({ userId: idSchema }),
	query: null,
	body: z.object({ action: z.enum(["shelve", "unshelve", "admit"]) }),
	response: z.undefined(),
	successStatuses: [204],
});

/**
 * Every team's usage this UTC month: the Runs it counted, its usage priced at
 * list rates when read (never stored), and its monthly quota.
 */
export const listTeamUsageContract = defineApiContract({
	id: "waitlist.internal.teams",
	method: "GET",
	path: "/api/waitlist/internal/teams",
	params: null,
	query: null,
	body: null,
	response: z.object({
		teams: z.array(
			z.object({
				teamId: idSchema,
				name: z.string(),
				slug: z.string(),
				runsThisMonth: z.number().int().nonnegative(),
				costThisMonthUsd: z.number().nonnegative(),
				monthlyRunQuota: z.number().int().nonnegative().nullable(),
			}),
		),
	}),
	successStatuses: [200],
});

/** A team's monthly Run quota; null is no limit. */
export const setTeamRunQuotaContract = defineApiContract({
	id: "waitlist.internal.setTeamRunQuota",
	method: "PATCH",
	path: "/api/waitlist/internal/teams/:teamId",
	params: z.object({ teamId: idSchema }),
	query: null,
	body: z.object({
		monthlyRunQuota: z.number().int().nonnegative().max(1_000_000).nullable(),
	}),
	response: z.undefined(),
	successStatuses: [204],
});

/** The shared password the internal lane is authorized by. */
export const WAITLIST_ADMIN_HEADER = "x-shipbash-waitlist-admin";
