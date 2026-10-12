/**
 * Actor facet — the waiting list's two reader doors.
 *
 * Trusted rather than RLS-scoped, for the same reason the evidence gate's
 * doors are: the reader standing here is not a member of anything we would
 * scope them by, and `waitlist_requests` grants the browser roles nothing at
 * all. Both statements are bound to the caller's own user id and reach exactly
 * one row, so there is nothing wider for the trust to leak.
 */

import type { TenantActor } from "../types.ts";
import { ActorStoreSpine } from "./actor-spine.ts";
import { nonEmpty } from "./normalize.ts";
import {
	joinWaitlist,
	readWaitlistStanding,
	type WaitlistStanding,
} from "./waitlist.ts";

export class ActorWaitlistStore extends ActorStoreSpine {
	/** The ask itself, never its state. */
	async readWaitlistStanding(
		actor: TenantActor,
	): Promise<WaitlistStanding | null> {
		return this.withTrustedActor(actor, async (sql) =>
			readWaitlistStanding(sql, actor.userId),
		);
	}

	async joinWaitlist(
		actor: TenantActor,
		input: { email: string; site: string },
	): Promise<WaitlistStanding> {
		const email = nonEmpty(input.email, "email");
		const site = nonEmpty(input.site, "site");
		return this.withTrustedActor(actor, async (sql) =>
			joinWaitlist(sql, { userId: actor.userId, email, site }),
		);
	}
}
