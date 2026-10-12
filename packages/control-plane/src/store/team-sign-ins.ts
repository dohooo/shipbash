/**
 * Team sign-ins: the ways into the tested product a Team has saved, and the
 * sealed material behind them. Pure sql-first functions — the tenant-store
 * facade owns actor scoping and the Team Admin checks.
 *
 * Two rules shape this file. Ciphertext never leaves it: the projection a
 * member reads carries only whether a credential or a session exists, and the
 * sealed columns are touched solely by the trusted door that opens them. And
 * a row the environment can no longer open is never reported as a Team that
 * saved nothing — the member view marks it paused, the trusted door raises
 * SignInCryptoError — so a key that went missing reads as a key that went
 * missing.
 */
import { randomUUID } from "node:crypto";

import type postgres from "postgres";

import type {
  TeamSignInFailureReason,
  TeamSignInMethod,
  TeamSignInStatus,
} from "@shipbash/contracts/database-contract-types";
import type { TableRow } from "../generated/database/index.ts";
import { isRecord } from "../is-record.ts";
import {
  MAX_SIGN_IN_SESSION_BYTES,
  SignInCryptoError,
  type SignInKeyring,
} from "../sign-in-crypto.ts";
import { expectRow } from "./expect-row.ts";
import { iso, nonEmpty } from "./normalize.ts";
import type { SelectedRow, Timestamp } from "./table-rows.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** The team_sign_ins columns a sign-in card maps from, as PROJECT_ROW_COLUMNS. */
export const TEAM_SIGN_IN_ROW_COLUMNS = [
  "id",
  "team_id",
  "method",
  "label",
  "login_url",
  "status",
  "failure_reason",
  "consecutive_failures",
  "encryption_key_id",
  "last_verified_at",
  "created_at",
  "updated_at",
] as const;

export type TeamSignInRow = SelectedRow<
  "team_sign_ins",
  (typeof TEAM_SIGN_IN_ROW_COLUMNS)[number],
  {
    method: TeamSignInMethod;
    status: TeamSignInStatus;
    failure_reason: TeamSignInFailureReason | null;
    last_verified_at: Timestamp | null;
    created_at: Timestamp;
    updated_at: Timestamp;
  }
>;

export type TeamSignInSealedRow = TeamSignInRow &
  Pick<TableRow<"team_sign_ins">, "credential_ciphertext" | "session_ciphertext">;

export interface TeamSignIn {
  id: string;
  teamId: string;
  method: TeamSignInMethod;
  label: string | null;
  loginUrl: string | null;
  status: TeamSignInStatus;
  failureReason: TeamSignInFailureReason | null;
  consecutiveFailures: number;
  /** False once the environment no longer carries the key that sealed this row. */
  encryptionKeyAvailable: boolean;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamSignInCredential {
  email: string;
  password: string;
  totpSecret: string | null;
}

export interface TeamSignInSecrets {
  signIn: TeamSignIn;
  credential: TeamSignInCredential | null;
  session: string | null;
}

export interface UpdateTeamSignInInput {
  status?: TeamSignInStatus;
  label?: string | null;
  failureReason?: TeamSignInFailureReason | null;
  consecutiveFailures?: number;
  loginUrl?: string | null;
  /** A whole replacement; the stored envelope is resealed, never merged into. */
  credential?: TeamSignInCredential | null;
  /**
   * A whole replacement, written with the GitHub account its cookies name.
   * Only a GitHub way in keeps that account: another method's browser may
   * still hold GitHub cookies from an earlier save.
   */
  session?: { state: string; version: string; githubAccountLogin: string | null } | null;
}

/**
 * Row→domain, carrying the one policy this table has: a sealed row whose key
 * the environment has lost reads as paused with an unknown failure.
 */
export function mapTeamSignIn(row: TeamSignInRow, keyring: SignInKeyring | null): TeamSignIn {
  const encryptionKeyAvailable =
    row.encryption_key_id === null || keyring?.has(row.encryption_key_id) === true;
  return {
    id: row.id,
    teamId: row.team_id,
    method: row.method,
    label: row.label,
    loginUrl: row.login_url,
    status: encryptionKeyAvailable ? row.status : "paused",
    failureReason: encryptionKeyAvailable ? row.failure_reason : "unknown",
    consecutiveFailures: row.consecutive_failures,
    encryptionKeyAvailable,
    lastVerifiedAt: iso(row.last_verified_at, "team_sign_ins.last_verified_at"),
    createdAt: iso(row.created_at, "team_sign_ins.created_at"),
    updatedAt: iso(row.updated_at, "team_sign_ins.updated_at"),
  };
}

export async function listTeamSignIns(
  sql: Queryable,
  input: { userId: string; teamId: string },
  keyring: SignInKeyring | null,
): Promise<TeamSignIn[]> {
  const rows = await sql<TeamSignInRow[]>`
    select sign_in.id, sign_in.team_id, sign_in.method, sign_in.label, sign_in.login_url,
      sign_in.status, sign_in.failure_reason, sign_in.consecutive_failures,
      sign_in.encryption_key_id, sign_in.last_verified_at, sign_in.created_at, sign_in.updated_at
    from public.team_memberships membership
    join public.team_sign_ins sign_in on sign_in.team_id = membership.team_id
    where membership.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and membership.user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
      and sign_in.status <> 'revoked'
    order by sign_in.created_at desc
  `;
  return rows.map((row) => mapTeamSignIn(row, keyring));
}

/**
 * The one door that opens sealed material. The caller has already proven it
 * is a Team Admin; a row sealed by a key this process does not hold raises
 * rather than answering with an empty credential.
 */
export async function readTeamSignInSecrets(
  sql: Queryable,
  input: { teamId: string; signInId: string },
  keyring: SignInKeyring | null,
): Promise<TeamSignInSecrets | null> {
  const rows = await sql<TeamSignInSealedRow[]>`
    select id, team_id, method, label, login_url, status, failure_reason,
      consecutive_failures, credential_ciphertext, session_ciphertext,
      encryption_key_id, last_verified_at, created_at, updated_at
    from public.team_sign_ins
    where team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and id = ${nonEmpty(input.signInId, "signInId")}::uuid
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  const signIn = mapTeamSignIn(row, keyring);
  const sealed = row.credential_ciphertext ?? row.session_ciphertext;
  if (sealed !== null && !keyring) {
    throw new SignInCryptoError(
      "unconfigured",
      "This sign-in is sealed, and no sign-in encryption key is configured.",
    );
  }
  return {
    signIn,
    credential:
      row.credential_ciphertext && keyring
        ? parseCredential(keyring.open(row.id, row.credential_ciphertext))
        : null,
    session: row.session_ciphertext && keyring ? keyring.open(row.id, row.session_ciphertext) : null,
  };
}

/** Trusted callers authorize the task or actor before requesting only login fields. */
export async function readTeamSignInCredential(
  sql: Queryable, input: { teamId: string; signInId: string }, keyring: SignInKeyring | null,
): Promise<TeamSignInCredential | null> {
  const [row] = await sql<Array<{ credential_ciphertext: string | null }>>`
    select credential_ciphertext from public.team_sign_ins
    where team_id=${input.teamId}::uuid and id=${input.signInId}::uuid`;
  if (!row?.credential_ciphertext) return null;
  if (!keyring) throw new SignInCryptoError("unconfigured", "Sign-in encryption is unavailable.");
  return parseCredential(keyring.open(input.signInId, row.credential_ciphertext));
}

function parseCredential(plaintext: string): TeamSignInCredential {
  const parsed: unknown = JSON.parse(plaintext);
  if (!isRecord(parsed) || typeof parsed.email !== "string" || typeof parsed.password !== "string") {
    throw new Error("Stored sign-in credential does not hold an email and a password.");
  }
  return {
    email: parsed.email,
    password: parsed.password,
    totpSecret: typeof parsed.totpSecret === "string" ? parsed.totpSecret : null,
  };
}

/**
 * Which lane a saved sign-in is, without opening anything sealed — the one
 * fact a caller needs before it can decide whether a credential belongs on
 * this row at all.
 */
export async function readTeamSignInMethod(
  sql: Queryable,
  input: { teamId: string; signInId: string },
): Promise<TeamSignInMethod | null> {
  const rows = await sql<Array<{ method: TeamSignInMethod }>>`
    select method
    from public.team_sign_ins
    where team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and id = ${nonEmpty(input.signInId, "signInId")}::uuid
      and status <> 'revoked'
    limit 1
  `;
  return rows[0]?.method ?? null;
}

export async function insertTeamSignIn(
  sql: postgres.TransactionSql,
  input: {
    teamId: string;
    createdBy: string;
    method: TeamSignInMethod;
    loginUrl: string | null;
    credential: TeamSignInCredential | null;
  },
  keyring: SignInKeyring,
): Promise<TeamSignIn> {
  const id = randomUUID();
  const sealed = input.credential ? keyring.seal(id, JSON.stringify(input.credential)) : null;
  const rows = await sql<TeamSignInRow[]>`
    insert into public.team_sign_ins (
      id, team_id, method, login_url, credential_ciphertext, encryption_key_id, created_by
    ) values (
      ${id}::uuid, ${input.teamId}::uuid, ${input.method}, ${input.loginUrl},
      ${sealed?.envelope ?? null}, ${sealed?.keyId ?? null}, ${input.createdBy}::uuid
    )
    returning ${sql(TEAM_SIGN_IN_ROW_COLUMNS)}
  `;
  return mapTeamSignIn(expectRow(rows, "team_sign_ins", "insert"), keyring);
}

interface SignInUpdateMaterial {
  credentialProvided: boolean;
  credentialEnvelope: string | null;
  sessionProvided: boolean;
  sessionEnvelope: string | null;
  sessionVersion: string | null;
  githubAccountLogin: string | null;
  keyId: string | null;
}

/**
 * Everything one update seals, sealed in one place. A field that was left out
 * is not the same as a field set to null — the first keeps what the row holds,
 * the second destroys it — so each carries its own "provided" flag. Both
 * envelopes take the keyring's active key, so the row records one key id
 * whichever of them was written.
 */
function sealSignInUpdate(
  signInId: string,
  input: UpdateTeamSignInInput,
  keyring: SignInKeyring,
): SignInUpdateMaterial {
  const credential = input.credential
    ? keyring.seal(signInId, JSON.stringify(input.credential))
    : null;
  // A captured session is the whole browser, not a password: it is sealed
  // under the limit its own kind carries, or no product with a real amount of
  // stored state could ever be signed in to.
  const session = input.session
    ? keyring.seal(signInId, input.session.state, { maxBytes: MAX_SIGN_IN_SESSION_BYTES })
    : null;
  return {
    credentialProvided: input.credential !== undefined,
    credentialEnvelope: credential ? credential.envelope : null,
    sessionProvided: input.session !== undefined,
    sessionEnvelope: session ? session.envelope : null,
    sessionVersion: input.session ? input.session.version : null,
    githubAccountLogin: input.session?.githubAccountLogin ?? null,
    keyId: (session ?? credential)?.keyId ?? null,
  };
}

export async function updateTeamSignIn(
  sql: postgres.TransactionSql,
  input: { teamId: string; signInId: string } & UpdateTeamSignInInput,
  keyring: SignInKeyring,
): Promise<TeamSignIn | null> {
  const sealed = sealSignInUpdate(input.signInId, input, keyring);
  const rows = await sql<TeamSignInRow[]>`
    update public.team_sign_ins
    set status = coalesce(${input.status ?? null}::text, status),
        label = case when ${input.label !== undefined} then ${input.label ?? null}::text else label end,
        failure_reason = case
          when ${input.failureReason !== undefined} then ${input.failureReason ?? null}::text
          else failure_reason end,
        consecutive_failures =
          coalesce(${input.consecutiveFailures ?? null}::integer, consecutive_failures),
        login_url = case
          when ${input.loginUrl !== undefined} then ${input.loginUrl ?? null}::text
          else login_url end,
        credential_ciphertext = case
          when ${sealed.credentialProvided} then ${sealed.credentialEnvelope}::text
          else credential_ciphertext end,
        session_ciphertext = case
          when ${sealed.sessionProvided} then ${sealed.sessionEnvelope}::text
          else session_ciphertext end,
        session_version = case
          when ${sealed.sessionProvided} then ${sealed.sessionVersion}::text else session_version end,
        github_account_login = case
          when not ${sealed.sessionProvided} then github_account_login
          when method = 'github' then ${sealed.githubAccountLogin}::text end,
        encryption_key_id = coalesce(${sealed.keyId}::text, encryption_key_id),
        last_verified_at = case
          when ${input.status ?? null}::text = 'ready' then now() else last_verified_at end,
        updated_at = now()
    where team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and id = ${nonEmpty(input.signInId, "signInId")}::uuid
      and status <> 'revoked'
    returning ${sql(TEAM_SIGN_IN_ROW_COLUMNS)}
  `;
  const row = rows[0];
  return row ? mapTeamSignIn(row, keyring) : null;
}

/**
 * Revoking destroys the sealed material in place. The row stays for the audit
 * trail and leaves the unique index, so the same account can be saved again.
 */
export async function revokeTeamSignIn(
  sql: postgres.TransactionSql,
  input: { teamId: string; signInId: string },
  keyring: SignInKeyring | null,
): Promise<TeamSignIn | null> {
  const rows = await sql<TeamSignInRow[]>`
    update public.team_sign_ins
    set status = 'revoked', credential_ciphertext = null, session_ciphertext = null,
        session_version = null, github_account_login = null, encryption_key_id = null,
        updated_at = now()
    where team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and id = ${nonEmpty(input.signInId, "signInId")}::uuid
    returning ${sql(TEAM_SIGN_IN_ROW_COLUMNS)}
  `;
  const row = rows[0];
  return row ? mapTeamSignIn(row, keyring) : null;
}
