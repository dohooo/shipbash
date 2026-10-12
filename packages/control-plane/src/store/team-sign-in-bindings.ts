/**
 * The two tables around a Team sign-in: which Projects use it, and what has
 * happened to it. Neither holds a secret — the binding is a fact about a
 * Project, and the event row is the audit trail the Team page reads, so the
 * failure word is the only thing an outcome ever carries.
 */
import type postgres from "postgres";

import type {
  TeamSignInEventAction,
  TeamSignInEventActor,
  TeamSignInFailureReason,
  TeamSignInMethod,
} from "@shipbash/contracts/database-contract-types";
import type { SignInKeyring } from "../sign-in-crypto.ts";
import { expectRow } from "./expect-row.ts";
import { iso, nonEmpty } from "./normalize.ts";
import type { SelectedRow, Timestamp } from "./table-rows.ts";
import {
  mapTeamSignIn,
  revokeTeamSignIn,
  TEAM_SIGN_IN_ROW_COLUMNS,
  type TeamSignIn,
  type TeamSignInRow,
} from "./team-sign-ins.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

type ProjectSignInRow = SelectedRow<
  "project_sign_ins",
  "project_id" | "sign_in_id" | "team_id" | "created_at",
  { created_at: Timestamp }
>;

export interface ProjectSignInBinding {
  projectId: string;
  signInId: string;
  teamId: string;
  createdAt: string;
}

export interface TeamSignInEventInput {
  signInId: string;
  projectId?: string | null;
  actor: TeamSignInEventActor;
  actorUserId?: string | null;
  action: TeamSignInEventAction;
  outcome?: TeamSignInFailureReason | null;
}

function mapBinding(row: ProjectSignInRow): ProjectSignInBinding {
  return {
    projectId: row.project_id,
    signInId: row.sign_in_id,
    teamId: row.team_id,
    createdAt: iso(row.created_at, "project_sign_ins.created_at"),
  };
}

/**
 * Binding the same sign-in twice is the same fact stated twice, so the
 * existing row is returned rather than treated as a conflict.
 */
export async function bindProjectSignIn(
  sql: postgres.TransactionSql,
  input: { teamId: string; projectId: string; signInId: string },
): Promise<ProjectSignInBinding> {
  const rows = await sql<ProjectSignInRow[]>`
    insert into public.project_sign_ins (project_id, sign_in_id, team_id)
    values (
      ${nonEmpty(input.projectId, "projectId")}, ${nonEmpty(input.signInId, "signInId")}::uuid,
      ${nonEmpty(input.teamId, "teamId")}::uuid
    )
    on conflict (project_id, sign_in_id) do update set team_id = excluded.team_id
    returning project_id, sign_in_id, team_id, created_at
  `;
  return mapBinding(expectRow(rows, "project_sign_ins", "insert"));
}

export async function unbindProjectSignIn(
  sql: postgres.TransactionSql,
  input: { teamId: string; projectId: string; signInId: string },
): Promise<boolean> {
  const rows = await sql<Array<{ sign_in_id: string }>>`
    delete from public.project_sign_ins
    where team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and project_id = ${nonEmpty(input.projectId, "projectId")}
      and sign_in_id = ${nonEmpty(input.signInId, "signInId")}::uuid
    returning sign_in_id
  `;
  return Boolean(rows[0]);
}

/** A way in as the Project that bound it sees it: the Team's row, and whether its verification runs sign in with it. */
export type BoundSignIn = TeamSignIn & { forRuns: boolean };

export async function listProjectSignIns(
  sql: Queryable,
  input: { userId: string; teamId: string; projectId: string },
  keyring: SignInKeyring | null,
): Promise<BoundSignIn[]> {
  const rows = await sql<Array<TeamSignInRow & { for_runs: boolean }>>`
    select sign_in.id, sign_in.team_id, sign_in.method, sign_in.label, sign_in.login_url,
      sign_in.status, sign_in.failure_reason, sign_in.consecutive_failures,
      sign_in.encryption_key_id, sign_in.last_verified_at, sign_in.created_at, sign_in.updated_at,
      binding.for_runs
    from public.team_memberships membership
    join public.project_sign_ins binding on binding.team_id = membership.team_id
    join public.team_sign_ins sign_in on sign_in.id = binding.sign_in_id
    where membership.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and membership.user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
      and binding.project_id = ${nonEmpty(input.projectId, "projectId")}
      and sign_in.status <> 'revoked'
    order by sign_in.created_at desc
  `;
  return rows.map(({ for_runs, ...row }) => ({ ...mapTeamSignIn(row, keyring), forRuns: for_runs }));
}

type ProjectScope = { teamId: string; projectId: string };

/**
 * Every way in this Project has bound, locked, with whether its runs use it.
 * Locking all of them is what keeps two choices made at once from both
 * winning: the second waits, then reads the first.
 */
async function lockedBindings(sql: postgres.TransactionSql, scope: ProjectScope) {
  return sql<Array<{ sign_in_id: string; for_runs: boolean; status: string }>>`
    select binding.sign_in_id, binding.for_runs, sign_in.status
    from public.project_sign_ins binding
    join public.team_sign_ins sign_in on sign_in.id = binding.sign_in_id
    where binding.team_id = ${nonEmpty(scope.teamId, "teamId")}::uuid
      and binding.project_id = ${nonEmpty(scope.projectId, "projectId")}
    for update of binding
  `;
}

/** Moves the Project's runs onto this way in. The old choice is cleared first: the index allows one at any moment. */
async function markRunSignIn(sql: postgres.TransactionSql, scope: ProjectScope, signInId: string): Promise<void> {
  await sql`
    update public.project_sign_ins set for_runs = false
    where team_id = ${scope.teamId}::uuid and project_id = ${scope.projectId}
      and for_runs and sign_in_id <> ${signInId}::uuid
  `;
  await sql`
    update public.project_sign_ins set for_runs = true
    where team_id = ${scope.teamId}::uuid and project_id = ${scope.projectId} and sign_in_id = ${signInId}::uuid
  `;
}

/**
 * The owner's choice of the way in this Project's verification runs sign in
 * with: a bound way in that is ready. Answers false, changing nothing, for
 * any other.
 */
export async function chooseProjectRunSignIn(
  sql: postgres.TransactionSql,
  input: ProjectScope & { signInId: string },
): Promise<boolean> {
  const bindings = await lockedBindings(sql, input);
  if (!bindings.some((binding) => binding.sign_in_id === input.signInId && binding.status === "ready")) return false;
  await markRunSignIn(sql, input, input.signInId);
  return true;
}

/**
 * A bound way in that has just been proved becomes the one runs sign in with
 * when the Project has none yet; a chosen way in since revoked counts as none.
 * Answers whether runs sign in with it now — which is what decides whether
 * its session becomes the one runs start from.
 */
export async function claimProjectRunSignIn(
  sql: postgres.TransactionSql,
  input: ProjectScope & { signInId: string },
): Promise<boolean> {
  const bindings = await lockedBindings(sql, input);
  const chosen = bindings.find((binding) => binding.for_runs && binding.status !== "revoked");
  if (chosen) return chosen.sign_in_id === input.signInId;
  if (!bindings.some((binding) => binding.sign_in_id === input.signInId)) return false;
  await markRunSignIn(sql, input, input.signInId);
  return true;
}

/**
 * A verification leg proved an account the Team already saved under this
 * method. Two non-revoked rows may not share (team, method, label), so the row
 * the Team already had is folded away rather than left to collide with the
 * unique index and strand the proved row `verifying`: every Project pointing at
 * the old row is pointed at the proved one, and the old row is revoked. The
 * caller then ticks the proved row to that label the way it ticks any other
 * success. All of it runs in the one transaction the caller opens, so a crash
 * can never leave a Project bound only to a row that is no longer a way in.
 *
 * The row this leg proved is the one that survives, and that is the whole
 * point: its session is already sealed under its own id, so nothing is carried
 * or resealed between rows, and there is no failure here that could tick a row
 * ready over a session it never proved.
 *
 * Revoking is what takes the old row out of the partial unique index while
 * keeping it, and its own audit trail, to read back later. Its Project
 * bindings stay for the same reason; every list this Project reads skips a
 * revoked row already.
 *
 * Answers the row that was folded away, or null when the label is new to the
 * Team — then there was no collision to clear and the caller simply ticks.
 */
export async function foldDuplicateTeamSignIn(
  sql: postgres.TransactionSql,
  input: { teamId: string; method: TeamSignInMethod; label: string; newSignInId: string },
): Promise<TeamSignIn | null> {
  const teamId = nonEmpty(input.teamId, "teamId");
  const newSignInId = nonEmpty(input.newSignInId, "newSignInId");
  const existing = await sql<TeamSignInRow[]>`
    select ${sql(TEAM_SIGN_IN_ROW_COLUMNS)}
    from public.team_sign_ins
    where team_id = ${teamId}::uuid
      and method = ${input.method}
      and label = ${nonEmpty(input.label, "label")}
      and status <> 'revoked'
      and id <> ${newSignInId}::uuid
    order by created_at
    limit 1
    for update
  `;
  const superseded = existing[0];
  if (!superseded) return null;
  // Every Project on the old row gains a binding to the proved one; a Project
  // already on both keeps its single row.
  await sql`
    insert into public.project_sign_ins (project_id, sign_in_id, team_id)
    select binding.project_id, ${newSignInId}::uuid, binding.team_id
    from public.project_sign_ins binding
    where binding.sign_in_id = ${superseded.id}::uuid
    on conflict (project_id, sign_in_id) do nothing
  `;
  // A Project whose runs signed in with the old row signs in with the proved
  // one: it is the same account. Cleared before it is set, since a Project has
  // one at most at any moment.
  const runs = await sql<Array<{ project_id: string }>>`
    update public.project_sign_ins set for_runs = false
    where sign_in_id = ${superseded.id}::uuid and for_runs
    returning project_id
  `;
  if (runs.length > 0) {
    await sql`
      update public.project_sign_ins set for_runs = true
      where sign_in_id = ${newSignInId}::uuid
        and project_id = any(${sql.array(runs.map((run) => run.project_id))}::text[])
    `;
  }
  return revokeTeamSignIn(sql, { teamId, signInId: superseded.id }, null);
}

export async function insertTeamSignInEvent(
  sql: postgres.TransactionSql,
  input: { teamId: string } & TeamSignInEventInput,
): Promise<void> {
  await sql`
    insert into public.team_sign_in_events (
      team_id, sign_in_id, project_id, actor, actor_user_id, action, outcome
    ) values (
      ${nonEmpty(input.teamId, "teamId")}::uuid, ${nonEmpty(input.signInId, "signInId")}::uuid,
      ${input.projectId ?? null}, ${input.actor}, ${input.actorUserId ?? null}::uuid,
      ${input.action}, ${input.outcome ?? null}
    )
  `;
}
