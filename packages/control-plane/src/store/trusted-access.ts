/**
 * Project trusted access (Cloudflare header bypass): the member read, the
 * header value sealed in its own row under the sign-in keyring, the two
 * openings (a verification's and a task's), verification, and revocation,
 * which drops the sealed value as revoking a sign-in drops its credential.
 * The tenant-store facade owns actor scoping and the admin checks.
 */
import type postgres from "postgres";

import { SIGN_IN_ENCRYPTION_KEYS_VARIABLE, SignInCryptoError, type SignInKeyring } from "../sign-in-crypto.ts";
import { nonEmpty } from "./normalize.ts";
import { type ProjectTrustedAccessRow, TRUSTED_ACCESS_ROW_COLUMNS } from "./rows.ts";
import { mapProjectTrustedAccess } from "./workspace-maps.ts";
import type { ProjectTrustedAccess, TenantActor } from "../types.ts";
import { expectRow } from "./expect-row.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** A live row's header as a host sends it. */
export interface OpenedTrustedAccessHeader {
  headerName: string;
  headerValue: string;
}

/** The live header, and the sealed value it is stored as: what a verification names the credential it checked by. */
export interface OpenedTrustedAccess extends OpenedTrustedAccessHeader {
  secretCiphertext: string;
}

interface SealedHeaderRow {
  header_name: string;
  secret_ciphertext: string;
}

function requireKeyring(keyring: SignInKeyring | null): SignInKeyring {
  if (!keyring) {
    throw new SignInCryptoError(
      "unconfigured",
      `Trusted Access needs ${SIGN_IN_ENCRYPTION_KEYS_VARIABLE}; nothing is stored unsealed.`,
    );
  }
  return keyring;
}

/** The value is bound to its Project: a sealed value copied onto another Project's row never opens. */
function sealingKey(projectId: string): string {
  return `trusted-access:${projectId}`;
}

function openHeader(keyring: SignInKeyring | null, projectId: string, row: SealedHeaderRow): OpenedTrustedAccessHeader {
  return {
    headerName: row.header_name,
    headerValue: requireKeyring(keyring).open(sealingKey(projectId), row.secret_ciphertext),
  };
}

export async function getProjectTrustedAccess(
  sql: Queryable,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
): Promise<ProjectTrustedAccess | null> {
  const rows = await sql<ProjectTrustedAccessRow[]>`
    select access.project_id, access.team_id, access.mode, access.header_name,
      access.status, access.last_verified_at, access.created_at, access.updated_at
    from public.team_memberships membership
    join public.project_trusted_access access
      on access.team_id = membership.team_id
    where membership.team_id = ${scopedTeamId}::uuid
      and membership.user_id = ${nonEmpty(actor.userId, "actor.userId")}::uuid
      and access.project_id = ${scopedProjectId}
      and access.status <> 'revoked'
    limit 1
  `;
  return rows[0] ? mapProjectTrustedAccess(rows[0]) : null;
}

/** The Project's live (not revoked) header, opened, or null when it has none. */
export async function openProjectTrustedAccess(
  sql: Queryable,
  keyring: SignInKeyring | null,
  input: { teamId: string; projectId: string },
): Promise<OpenedTrustedAccess | null> {
  const projectId = nonEmpty(input.projectId, "projectId");
  const [row] = await sql<SealedHeaderRow[]>`
    select header_name, secret_ciphertext
    from public.project_trusted_access
    where team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and project_id = ${projectId}
      and status <> 'revoked'
    limit 1
  `;
  return row ? { ...openHeader(keyring, projectId, row), secretCiphertext: row.secret_ciphertext } : null;
}

/**
 * The origin the Project's header is verified for, or null when it has none
 * verified: one column off the primary key, which every task asks before
 * anything costlier, since most Projects have no Trusted Access at all.
 */
export async function readyTrustedAccessOrigin(
  sql: Queryable,
  input: { teamId: string; projectId: string },
): Promise<string | null> {
  const [row] = await sql<Array<{ verified_origin: string | null }>>`
    select verified_origin
    from public.project_trusted_access
    where team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and project_id = ${nonEmpty(input.projectId, "projectId")}
      and status = 'ready'
    limit 1
  `;
  return row?.verified_origin ?? null;
}

/**
 * The header a task sends: the Project's, opened, only while it is verified
 * for exactly `origin`. Any other row is never opened, so it costs a task
 * nothing, not even a key the deployment has lost.
 */
export async function openDispatchTrustedAccess(
  sql: Queryable,
  keyring: SignInKeyring | null,
  input: { teamId: string; projectId: string; origin: string },
): Promise<OpenedTrustedAccessHeader | null> {
  const projectId = nonEmpty(input.projectId, "projectId");
  const [row] = await sql<SealedHeaderRow[]>`
    select header_name, secret_ciphertext
    from public.project_trusted_access
    where team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and project_id = ${projectId}
      and status = 'ready'
      and verified_origin = ${nonEmpty(input.origin, "origin")}
    limit 1
  `;
  return row ? openHeader(keyring, projectId, row) : null;
}

/** Saves a new header value, sealed; a rotation is unverified until it is verified again. */
export async function upsertProjectTrustedAccess(
  sql: postgres.TransactionSql,
  keyring: SignInKeyring | null,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
  input: { mode: ProjectTrustedAccess["mode"]; headerName: string; secret: string },
): Promise<ProjectTrustedAccess> {
  const sealed = requireKeyring(keyring).seal(sealingKey(scopedProjectId), input.secret);
  const rows = await sql<ProjectTrustedAccessRow[]>`
    insert into public.project_trusted_access (
      project_id, team_id, mode, header_name, secret_ciphertext, encryption_key_id,
      created_by, updated_by
    ) values (
      ${scopedProjectId}, ${scopedTeamId}::uuid, ${input.mode}, ${input.headerName},
      ${sealed.envelope}, ${sealed.keyId}, ${actor.userId}::uuid, ${actor.userId}::uuid
    )
    on conflict (project_id) do update
    set mode = excluded.mode, header_name = excluded.header_name,
        secret_ciphertext = excluded.secret_ciphertext,
        encryption_key_id = excluded.encryption_key_id,
        status = 'invalid', verified_origin = null, last_verified_at = null,
        updated_by = excluded.updated_by, updated_at = now()
    where project_trusted_access.team_id = excluded.team_id
    returning ${sql(TRUSTED_ACCESS_ROW_COLUMNS)}
  `;
  return mapProjectTrustedAccess(expectRow(rows, "project_trusted_access", "upsert"));
}

export async function updateProjectTrustedAccessVerification(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
  input: { verified: boolean },
  expectedSecretCiphertext: string,
  verifiedOrigin: string,
): Promise<ProjectTrustedAccess | null> {
  const rows = await sql<ProjectTrustedAccessRow[]>`
    update public.project_trusted_access
    set status = ${input.verified ? "ready" : "invalid"},
        verified_origin = ${input.verified ? verifiedOrigin : null},
        last_verified_at = case when ${input.verified} then now() else null end,
        updated_by = ${actor.userId}::uuid,
        updated_at = now()
    where team_id = ${scopedTeamId}::uuid
      and project_id = ${scopedProjectId}
      and secret_ciphertext = ${expectedSecretCiphertext}
      and status <> 'revoked'
    returning ${sql(TRUSTED_ACCESS_ROW_COLUMNS)}
  `;
  return rows[0] ? mapProjectTrustedAccess(rows[0]) : null;
}

export async function revokeProjectTrustedAccess(
  sql: postgres.TransactionSql,
  actor: TenantActor,
  scopedTeamId: string,
  scopedProjectId: string,
): Promise<ProjectTrustedAccess> {
  const rows = await sql<ProjectTrustedAccessRow[]>`
    select ${sql(TRUSTED_ACCESS_ROW_COLUMNS)}
    from public.project_trusted_access
    where team_id = ${scopedTeamId}::uuid
      and project_id = ${scopedProjectId}
    for update
  `;
  const existing = rows[0];
  if (!existing) throw new Error("Project trusted access not found.");
  if (existing.status === "revoked") return mapProjectTrustedAccess(existing);
  const revoked = await sql<ProjectTrustedAccessRow[]>`
    update public.project_trusted_access
    set status = 'revoked', secret_ciphertext = null, encryption_key_id = null,
        verified_origin = null, last_verified_at = null,
        updated_by = ${actor.userId}::uuid, updated_at = now()
    where team_id = ${scopedTeamId}::uuid
      and project_id = ${scopedProjectId}
    returning ${sql(TRUSTED_ACCESS_ROW_COLUMNS)}
  `;
  return mapProjectTrustedAccess(expectRow(revoked, "project_trusted_access", "update"));
}
