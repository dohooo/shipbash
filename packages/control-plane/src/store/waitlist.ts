/**
 * The waiting list.
 *
 * One row per account, because the wall is per account and asking twice is the
 * same ask. What the reader may read back is deliberately narrower than what
 * the row holds: `readWaitlistStanding` answers the ask itself and never its
 * state, so a shelved reader and a waiting reader are served the same page by
 * construction rather than by the page remembering to hide something.
 *
 * Admission is the whole point of the table, and it is three effects that must
 * not come apart: the row closes, the account gains the membership claim the
 * console proxy reads, and the one email we promised goes out. They share a
 * transaction, and the send runs before the commit, so a send that throws
 * leaves nobody let in with no mail and no way to notice.
 */
import type postgres from "postgres";

import { iso, nonEmpty } from "./normalize.ts";

/** What the reader told us, given back. Never the state. */
export interface WaitlistStanding {
	email: string;
	site: string;
	requestedAt: string;
}

/** A row as the internal list reads it — the state included. */
export interface WaitlistRequest extends WaitlistStanding {
	userId: string;
	state: "waiting" | "shelved" | "admitted";
	admittedAt: string | null;
}

export async function readWaitlistStanding(
	sql: postgres.TransactionSql,
	userId: string,
): Promise<WaitlistStanding | null> {
	const rows = await sql<
		Array<{ email: string; site: string; requested_at: Date | string }>
	>`
    select request.email, request.site, request.requested_at
    from public.waitlist_requests request
    where request.user_id = ${nonEmpty(userId, "actor.userId")}::uuid
  `;
	const row = rows[0];
	return row
		? {
				email: row.email,
				site: row.site,
				requestedAt: iso(row.requested_at, "waitlist_requests.requested_at"),
			}
		: null;
}

export async function joinWaitlist(
	sql: postgres.TransactionSql,
	input: { userId: string; email: string; site: string },
): Promise<WaitlistStanding> {
	// No upsert: a second ask must be refused rather than quietly rewrite the
	// first, because rewriting it would move an admitted row's site out from
	// under the mail we already sent.
	const rows = await sql<Array<{ requested_at: Date | string }>>`
    insert into public.waitlist_requests (user_id, email, site)
    values (
      ${nonEmpty(input.userId, "actor.userId")}::uuid,
      ${nonEmpty(input.email, "email")},
      ${nonEmpty(input.site, "site")}
    )
    on conflict (user_id) do nothing
    returning requested_at
  `;
	const row = rows[0];
	if (!row) throw new Error("You are already on the waiting list.");
	return {
		email: input.email,
		site: input.site,
		requestedAt: iso(row.requested_at, "waitlist_requests.requested_at"),
	};
}

export async function listWaitlistRequests(
	sql: postgres.Sql,
): Promise<WaitlistRequest[]> {
	const rows = await sql<
		Array<{
			user_id: string;
			email: string;
			site: string;
			state: WaitlistRequest["state"];
			requested_at: Date | string;
			admitted_at: Date | string | null;
		}>
	>`
    select request.user_id, request.email, request.site, request.state,
      request.requested_at, request.admitted_at
    from public.waitlist_requests request
    order by request.requested_at desc, request.user_id
  `;
	return rows.map((row) => ({
		userId: row.user_id,
		email: row.email,
		site: row.site,
		state: row.state,
		requestedAt: iso(row.requested_at, "waitlist_requests.requested_at"),
		admittedAt: iso(row.admitted_at, "waitlist_requests.admitted_at"),
	}));
}

const CLOSED = "This request was already let in, or there is no such request.";

/**
 * Shelving is ours, not theirs: it moves the row off the list we work through
 * and changes nothing the reader can see. An admitted row is past both states.
 */
export async function setWaitlistShelved(
	sql: postgres.Sql,
	userId: string,
	shelved: boolean,
): Promise<void> {
	const rows = await sql<Array<{ user_id: string }>>`
    update public.waitlist_requests
    set state = ${shelved ? "shelved" : "waiting"}
    where user_id = ${nonEmpty(userId, "userId")}::uuid and state <> 'admitted'
    returning user_id
  `;
	if (!rows[0]) throw new Error(CLOSED);
}

/**
 * Lets one account in. `beforeCommit` sends the mail inside the transaction on
 * purpose — a send that throws rolls the admission back, so the list never
 * shows someone as let in who was never told.
 */
export async function admitWaitlistRequest(
	sql: postgres.TransactionSql,
	userId: string,
	beforeCommit: (request: WaitlistStanding) => Promise<void>,
): Promise<void> {
	const scopedUserId = nonEmpty(userId, "userId");
	const rows = await sql<
		Array<{ email: string; site: string; requested_at: Date | string }>
	>`
    update public.waitlist_requests
    set state = 'admitted', admitted_at = now()
    where user_id = ${scopedUserId}::uuid and state <> 'admitted'
    returning email, site, requested_at
  `;
	const row = rows[0];
	if (!row) throw new Error(CLOSED);
	await sql`select shipbash_private.grant_membership(${scopedUserId}::uuid)`;
	await beforeCommit({
		email: row.email,
		site: row.site,
		requestedAt: iso(row.requested_at, "waitlist_requests.requested_at"),
	});
}
