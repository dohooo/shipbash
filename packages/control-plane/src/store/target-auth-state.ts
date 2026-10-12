/**
 * The tested product's browser sign-in state: which version of it a Target
 * Auth Profile holds, and — for the hosted lane, whose task Sandboxes keep
 * nothing — the state itself, the JSON agent-browser's `state save` produces,
 * sealed by the Team sign-in keyring with the profile's own id as the
 * authenticated data, so an envelope opens on its row and nowhere else.
 *
 * Every write that makes a sign-in the profile's current one goes through
 * writeStateVersion: a person's capture replaces whatever the profile holds,
 * and a task's verified sign-in lands only while the profile still holds the
 * version that task injected. The local lane keeps the bytes on its own disk
 * and writes only the version; the hosted lane writes the bytes with it.
 *
 * A row sealed by a key this process does not hold reads as a paused sign-in
 * (SignInCryptoError), never as "no state": answering null there would run
 * the task signed out and report a verdict the saved session never earned.
 */
import type postgres from "postgres";

import { AUTH_STATE_VERSION_PATTERN } from "@shipbash/contracts/runtime/browser-state-seal.mjs";

import { authStateVersion } from "../init-browser-auth-state.ts";
import { isRecord } from "../is-record.ts";
import {
  MAX_SIGN_IN_SESSION_BYTES,
  type SealedSignInSecret,
  SignInCryptoError,
  type SignInKeyring,
} from "../sign-in-crypto.ts";
import type { DispatchJobLeaseCapability } from "../types.ts";
import type { StoreConnection } from "./connection.ts";
import { lockDispatchJobCapability } from "./dispatch-capabilities.ts";
import { nonEmpty } from "./normalize.ts";
import { normalizeProductionUrl } from "./production-url.ts";
import { ensureTargetAuthProfile } from "./target-auth-profiles.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** A profile's saved sign-in and the version it is known by; null only on a row saved before versions were kept. */
export interface SavedTargetAuthState {
  stateJsonText: string;
  stateVersion: string | null;
}

/** A task's verified sign-in, and the version the task injected, which the write must still find. */
export interface TargetAuthPromotion {
  profileId: string;
  baseStateVersion: string | null;
}

/** What the sign-in handoff and the task preparers need of the store. */
export interface TargetAuthStateAccess {
  read(profileId: string): Promise<SavedTargetAuthState | null>;
  /** A person's capture: it replaces whatever the profile holds. */
  save(profileId: string, stateJsonText: string): Promise<void>;
  clear(profileId: string): Promise<void>;
  /** The Project's saved sign-in for this Production origin, or null when no handoff has captured one. */
  readForProject(teamId: string, projectId: string, productionUrl: string): Promise<string | null>;
  /** A person's capture, on the Project's profile for this Production origin, creating the row when it is the first. */
  saveForProject(teamId: string, projectId: string, productionUrl: string, stateJsonText: string): Promise<void>;
  /** A hosted task's verified sign-in, kept only while the profile still holds the version the task injected. */
  promoteForJob(
    capability: DispatchJobLeaseCapability,
    input: TargetAuthPromotion & { stateJsonText: string },
  ): Promise<"promoted" | "stale">;
}

/**
 * The one write that makes a sign-in the profile's current one: ready on
 * this version, verified now. A version is authStateVersion of the state's
 * bytes as its lane keeps them sealed — the local lane's file under the
 * Project's browser key, the hosted lane's envelope on this row — so it names
 * one saved write of a state, and two saves of the same state are two
 * versions. With a base the write lands only while the profile still holds
 * that version; without one, a person's own capture, it replaces whatever
 * the profile holds. The caller has scoped the profile. False when nothing
 * landed.
 */
async function writeStateVersion(
  sql: Queryable,
  input: { profileId: string; version: string; base?: string | null },
): Promise<boolean> {
  const version = nonEmpty(input.version, "version");
  if (!AUTH_STATE_VERSION_PATTERN.test(version)) throw new Error("The sign-in state version is invalid.");
  const stillHoldsBase = input.base === undefined
    ? sql``
    : sql`and state_version is not distinct from ${input.base}`;
  const rows = await sql`
    update public.target_auth_profiles
    set status = 'ready', state_version = ${version}, last_verified_at = now(),
        failure_reason = null, updated_at = now()
    where id = ${nonEmpty(input.profileId, "profileId")} ${stillHoldsBase}
    returning id
  `;
  return Boolean(rows[0]);
}

/** The version a state sealed on this row is known by: its envelope, by the rule above. */
function rowStateVersion(sealed: SealedSignInSecret): string {
  return authStateVersion(Buffer.from(sealed.envelope, "utf8"));
}

/**
 * writeStateVersion for a lane that keeps the bytes on this row: the bytes
 * land only with their version, in the caller's transaction.
 */
async function writeSealedState(
  sql: postgres.TransactionSql,
  input: { profileId: string; sealed: SealedSignInSecret; base?: string | null },
): Promise<boolean> {
  const { profileId, sealed } = input;
  const write = { profileId, version: rowStateVersion(sealed) };
  const landed = await writeStateVersion(sql, input.base === undefined ? write : { ...write, base: input.base });
  if (!landed) return false;
  await sql`
    update public.target_auth_profiles
    set state_ciphertext = ${sealed.envelope}, encryption_key_id = ${sealed.keyId},
        state_updated_at = now()
    where id = ${profileId}
  `;
  return true;
}

/** Locks the profile for a write when it belongs to the Team's Project; false otherwise. */
async function lockProfileInScope(
  sql: postgres.TransactionSql,
  scope: { profileId: string; teamId: string; projectId: string },
): Promise<boolean> {
  const rows = await sql`
    select 1 from public.target_auth_profiles
    where id = ${nonEmpty(scope.profileId, "profileId")}
      and team_id = ${nonEmpty(scope.teamId, "teamId")}::uuid
      and project_id = ${nonEmpty(scope.projectId, "projectId")}
    for update
  `;
  return Boolean(rows[0]);
}

/**
 * What a task must hold before it writes a sign-in back: a live lease, and a
 * profile in its Project — for a Suite Run, the one its snapshot names.
 */
async function lockPromotableProfile(
  sql: postgres.TransactionSql,
  capability: DispatchJobLeaseCapability,
  profileId: string,
): Promise<void> {
  const job = await lockDispatchJobCapability(sql, capability);
  if (job.kind === "suite_run") {
    const snapshots = await sql<Array<{ auth_profile_id: string | null }>>`
      select snapshot.auth_profile_id
      from public.suite_runs run
      join public.suite_snapshots snapshot
        on snapshot.id = run.suite_snapshot_id and snapshot.team_id = run.team_id
      where run.id = ${job.suite_run_id}
        and run.team_id = ${job.team_id}::uuid
        and run.project_id = ${job.project_id}
      for share of run, snapshot
    `;
    if (snapshots[0]?.auth_profile_id !== profileId) {
      throw new Error("Target Auth promotion does not match the immutable Run snapshot.");
    }
  }
  if (!(await lockProfileInScope(sql, { profileId, teamId: job.team_id, projectId: job.project_id }))) {
    throw new Error("Target Auth promotion is outside the Job's Project.");
  }
}

/**
 * A local task's verified sign-in, kept: its bytes are already on this host,
 * so only the version moves, over the version the task injected. The base is
 * the snapshot's for a Suite Run, and the one the leg injected for an
 * Activity.
 */
export async function promoteTargetAuthProfileForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  input: TargetAuthPromotion & { newStateVersion: string },
): Promise<boolean> {
  const profileId = nonEmpty(input.profileId, "profileId");
  return await sql.begin(async (sql) => {
    await lockPromotableProfile(sql, capability, profileId);
    return writeStateVersion(sql, { profileId, version: input.newStateVersion, base: input.baseStateVersion });
  });
}

/**
 * The sign-in verification leg's promotion, over the version the check
 * started from. The leg carries no dispatch lease and no local project
 * context — it is a Team Admin's browser, checked once — so it arrives scoped
 * by Team and Project instead.
 */
export async function markTargetAuthProfileReady(
  sql: postgres.Sql,
  input: {
    teamId: string;
    projectId: string;
    profileId: string;
    baseStateVersion: string | null;
    newStateVersion: string;
  },
): Promise<boolean> {
  return await sql.begin(async (sql) => {
    if (!(await lockProfileInScope(sql, input))) return false;
    return writeStateVersion(sql, {
      profileId: input.profileId,
      version: input.newStateVersion,
      base: input.baseStateVersion,
    });
  });
}

function assertStateJson(stateJsonText: string): void {
  let state: unknown;
  try {
    state = JSON.parse(stateJsonText);
  } catch {
    throw new Error("Target Auth state must be JSON.");
  }
  if (!isRecord(state)) throw new Error("Target Auth state must be a JSON object.");
}

function sealState(keyring: SignInKeyring, profileId: string, stateJsonText: string): SealedSignInSecret {
  assertStateJson(stateJsonText);
  return keyring.seal(profileId, stateJsonText, { maxBytes: MAX_SIGN_IN_SESSION_BYTES });
}

/** A person's capture, sealed on the profile: it replaces whatever the profile holds. */
export async function saveTargetAuthState(
  sql: postgres.Sql,
  keyring: SignInKeyring,
  profileId: string,
  stateJsonText: string,
): Promise<void> {
  const id = nonEmpty(profileId, "profileId");
  const sealed = sealState(keyring, id, stateJsonText);
  const saved = await sql.begin((sql) => writeSealedState(sql, { profileId: id, sealed }));
  if (!saved) throw new Error("Target Auth Profile not found.");
}

export async function readTargetAuthState(
  sql: Queryable,
  keyring: SignInKeyring | null,
  profileId: string,
): Promise<SavedTargetAuthState | null> {
  const id = nonEmpty(profileId, "profileId");
  const [row] = await sql<Array<{ state_ciphertext: string | null; state_version: string | null }>>`
    select state_ciphertext, state_version from public.target_auth_profiles where id = ${id}
  `;
  if (!row?.state_ciphertext) return null;
  if (!keyring) {
    throw new SignInCryptoError(
      "unconfigured",
      "This product sign-in is sealed, and no sign-in encryption key is configured.",
    );
  }
  return { stateJsonText: keyring.open(id, row.state_ciphertext), stateVersion: row.state_version };
}

async function projectAuthProfileId(
  sql: Queryable,
  teamId: string,
  projectId: string,
  productionUrl: string,
): Promise<string | null> {
  const productionOrigin = new URL(normalizeProductionUrl(productionUrl)).origin;
  const [row] = await sql<Array<{ id: string }>>`
    select id from public.target_auth_profiles
    where team_id = ${nonEmpty(teamId, "teamId")}::uuid
      and project_id = ${nonEmpty(projectId, "projectId")}
      and production_origin = ${productionOrigin}
  `;
  return row?.id ?? null;
}

/**
 * Forgets the sign-in: the bytes and the version they were known by, so no
 * task that injected that version can write it back as ready.
 */
export async function clearTargetAuthState(sql: Queryable, profileId: string): Promise<void> {
  await sql`
    update public.target_auth_profiles
    set state_ciphertext = null, encryption_key_id = null, state_updated_at = null,
        state_version = null, status = 'missing', updated_at = now()
    where id = ${nonEmpty(profileId, "profileId")}
  `;
}

export class TargetAuthStateStore implements TargetAuthStateAccess {
  constructor(
    private readonly connection: StoreConnection,
    private readonly keyring: SignInKeyring | null,
  ) {}

  read(profileId: string): Promise<SavedTargetAuthState | null> {
    return readTargetAuthState(this.connection.sql, this.keyring, profileId);
  }

  async save(profileId: string, stateJsonText: string): Promise<void> {
    await saveTargetAuthState(this.connection.sql, this.#sealingKeyring(), profileId, stateJsonText);
  }

  clear(profileId: string): Promise<void> {
    return clearTargetAuthState(this.connection.sql, profileId);
  }

  async readForProject(teamId: string, projectId: string, productionUrl: string): Promise<string | null> {
    const profileId = await projectAuthProfileId(this.connection.sql, teamId, projectId, productionUrl);
    return profileId === null ? null : (await this.read(profileId))?.stateJsonText ?? null;
  }

  async saveForProject(
    teamId: string,
    projectId: string,
    productionUrl: string,
    stateJsonText: string,
  ): Promise<void> {
    const keyring = this.#sealingKeyring();
    const profile = await ensureTargetAuthProfile(this.connection.sql, teamId, projectId, productionUrl);
    await saveTargetAuthState(this.connection.sql, keyring, profile.id, stateJsonText);
  }

  async promoteForJob(
    capability: DispatchJobLeaseCapability,
    input: TargetAuthPromotion & { stateJsonText: string },
  ): Promise<"promoted" | "stale"> {
    const profileId = nonEmpty(input.profileId, "profileId");
    const sealed = sealState(this.#sealingKeyring(), profileId, input.stateJsonText);
    const promoted = await this.connection.sql.begin(async (sql) => {
      await lockPromotableProfile(sql, capability, profileId);
      return writeSealedState(sql, { profileId, sealed, base: input.baseStateVersion });
    });
    return promoted ? "promoted" : "stale";
  }

  #sealingKeyring(): SignInKeyring {
    if (!this.keyring) {
      throw new SignInCryptoError("unconfigured", "Sign-in encryption is unavailable.");
    }
    return this.keyring;
  }
}
