/**
 * Team access requests: an invitation initiated from the other side.
 *
 * Someone opened a run in a Team they are not in. They cannot resolve that
 * Team through their own session — the session read answers a Team it cannot
 * see with a 404 — so the gate reads here address-first, the way the session
 * endpoint does, and answers with the least a stranger needs: the Team's name
 * and its admins' display names. Never an email address, never a project,
 * never the run.
 *
 * Callers own authorization, as everywhere in this store: the tenant facade
 * opens the transaction and proves the caller's team role before the writes
 * below run. The reads scope themselves through the caller's own membership
 * row, so a member who cannot grant access simply reads nothing.
 */
import type postgres from "postgres";

import { iso, nonEmpty } from "./normalize.ts";

export interface TeamAccessRequest {
	id: string;
	teamId: string;
	/** Who asked: their GitHub login, or the email of an account without one. */
	requester: string;
	createdAt: string;
}

export type TeamAccessGate =
	| { access: "member" }
	| {
			access: "outsider";
			teamName: string;
			adminNames: string[];
			requestedAt: string | null;
		};

/** The Team an address names, whether or not the reader may see it. */
async function addressedTeam(
	sql: postgres.TransactionSql,
	address: string,
): Promise<{ id: string; name: string }> {
	const rows = await sql<Array<{ id: string; name: string }>>`
    select team.id, team.name
    from public.teams team
    where team.slug = ${address} or team.id::text = ${address}
    limit 1
  `;
	const team = rows[0];
	if (!team) throw new Error("Team was not found.");
	return team;
}

async function isTeamMember(
	sql: postgres.TransactionSql,
	teamId: string,
	userId: string,
): Promise<boolean> {
	const rows = await sql<Array<{ present: number }>>`
    select 1 as present
    from public.team_memberships membership
    where membership.team_id = ${teamId}::uuid
      and membership.user_id = ${userId}::uuid
  `;
	return rows.length > 0;
}

export async function readTeamAccessGate(
	sql: postgres.TransactionSql,
	input: { address: string; userId: string },
): Promise<TeamAccessGate> {
	const address = nonEmpty(input.address, "team");
	const userId = nonEmpty(input.userId, "actor.userId");
	const team = await addressedTeam(sql, address);
	if (await isTeamMember(sql, team.id, userId)) return { access: "member" };
	const admins = await sql<Array<{ display_name: string }>>`
    select profile.display_name
    from public.team_memberships membership
    join public.user_profiles profile on profile.user_id = membership.user_id
    where membership.team_id = ${team.id}::uuid and membership.role = 'admin'
    order by lower(profile.display_name), membership.user_id
  `;
	// Declined counts as asked. The requester is told nothing either way, so
	// the page they come back to is the one that says they already asked.
	const open = await sql<Array<{ created_at: Date | string }>>`
    select request.created_at
    from public.team_access_requests request
    where request.team_id = ${team.id}::uuid
      and request.requested_by = ${userId}::uuid
      and request.status <> 'approved'
  `;
	return {
		access: "outsider",
		teamName: team.name,
		adminNames: admins.map((row) => row.display_name),
		requestedAt: open[0]
			? iso(open[0].created_at, "team_access_requests.created_at")
			: null,
	};
}

export async function requestTeamAccess(
	sql: postgres.TransactionSql,
	input: { address: string; userId: string },
): Promise<string> {
	const address = nonEmpty(input.address, "team");
	const userId = nonEmpty(input.userId, "actor.userId");
	const team = await addressedTeam(sql, address);
	if (await isTeamMember(sql, team.id, userId)) {
		throw new Error("You are already a member of this Team.");
	}
	// The conflict target is the partial unique index, and the update writes the
	// row's own status back: one statement answers with the request whether this
	// call filed it or found the one already standing. It must not take
	// `excluded.status` — that would return a declined request to the Admin's
	// card, which is the loop declining exists to end.
	const rows = await sql<Array<{ created_at: Date | string }>>`
    insert into public.team_access_requests (team_id, requested_by)
    values (${team.id}::uuid, ${userId}::uuid)
    on conflict (team_id, requested_by) where status <> 'approved'
    do update set status = team_access_requests.status
    returning created_at
  `;
	if (!rows[0]) throw new Error("Access request could not be filed.");
	return iso(rows[0].created_at, "team_access_requests.created_at");
}

/**
 * The requests one Team is waiting on, for a caller who can grant them. The
 * admin membership is a join rather than a guard that throws, so the Members
 * page reads the same for everyone and an ordinary member simply sees none.
 */
export async function listTeamAccessRequests(
	sql: postgres.TransactionSql,
	input: { teamId: string; userId: string },
): Promise<TeamAccessRequest[]> {
	const rows = await sql<
		Array<{ id: string; team_id: string; requester: string; created_at: Date | string }>
	>`
    select request.id, request.team_id, request.created_at,
      coalesce('@' || profile.github_login, profile.email) as requester
    from public.team_memberships actor_membership
    join public.team_access_requests request
      on request.team_id = actor_membership.team_id
    join public.user_profiles profile on profile.user_id = request.requested_by
    where actor_membership.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and actor_membership.user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
      and actor_membership.role = 'admin'
      and request.status = 'pending'
    order by request.created_at, request.id
  `;
	return rows.map((row) => ({
		id: row.id,
		teamId: row.team_id,
		requester: row.requester,
		createdAt: iso(row.created_at, "team_access_requests.created_at"),
	}));
}

/**
 * Approving is the membership insert `accept_team_invitation` performs, run in
 * the transaction that closes the request, so a Team never gains a member
 * whose request stayed open or loses a request whose member never landed.
 *
 * Declining is the same close with no membership and nothing said. The row
 * stays the requester's one request: it leaves the Admin's card and never
 * comes back, and the requester — who is told nothing — is not handed a fresh
 * ask to send again.
 */
export async function resolveTeamAccessRequest(
	sql: postgres.TransactionSql,
	input: {
		teamId: string;
		requestId: string;
		decision: "approve" | "decline";
		decidedBy: string;
	},
): Promise<void> {
	const rows = await sql<Array<{ requested_by: string }>>`
    update public.team_access_requests
    set status = ${input.decision === "approve" ? "approved" : "declined"},
      decided_by = ${nonEmpty(input.decidedBy, "actor.userId")}::uuid,
      decided_at = now()
    where id = ${nonEmpty(input.requestId, "requestId")}::uuid
      and team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and status = 'pending'
    returning requested_by
  `;
	const request = rows[0];
	if (!request) {
		throw new Error("Pending access request not found or not authorized.");
	}
	if (input.decision === "decline") return;
	await sql`
    insert into public.team_memberships (team_id, user_id, role)
    values (${input.teamId}::uuid, ${request.requested_by}::uuid, 'member')
    on conflict (team_id, user_id) do nothing
  `;
	// An approval is an admission: somebody already inside vouched for them, so
	// they do not also have to stand at the waiting list's wall.
	await sql`select shipbash_private.grant_membership(${request.requested_by}::uuid)`;
}
