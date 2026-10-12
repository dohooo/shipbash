/**
 * Actor facet — Team sign-ins. Reads run through withActor so row-level
 * security decides what a member sees; every write proves Team Admin through
 * the spine first, because a sign-in is the Team's way into its own live
 * product and not something a member may quietly replace.
 *
 * This is also where the encryption keyring enters the store. It is handed in
 * at construction rather than read from the environment here, so a service
 * without keys configured refuses the write instead of storing a plaintext
 * credential, and so a caller can seal with a key of its own.
 */
import { ActorTeamsStore } from "./actor-teams.ts";
import type { StoreConnection } from "./connection.ts";
import { nonEmpty } from "./normalize.ts";
import {
  SIGN_IN_ENCRYPTION_KEYS_VARIABLE,
  SignInCryptoError,
  type SignInKeyring,
} from "../sign-in-crypto.ts";
import {
  bindProjectSignIn,
  type BoundSignIn,
  chooseProjectRunSignIn,
  claimProjectRunSignIn,
  foldDuplicateTeamSignIn,
  insertTeamSignInEvent,
  listProjectSignIns,
  type ProjectSignInBinding,
  type TeamSignInEventInput,
  unbindProjectSignIn,
} from "./team-sign-in-bindings.ts";
import { reapStrandedSignIns } from "./sign-in-verification-reaper.ts";
import {
  insertTeamSignIn,
  listTeamSignIns,
  readTeamSignInMethod,
  readTeamSignInSecrets,
  revokeTeamSignIn,
  type TeamSignIn,
  type TeamSignInCredential,
  type TeamSignInSecrets,
  updateTeamSignIn,
  type UpdateTeamSignInInput,
} from "./team-sign-ins.ts";
import type { TenantActor } from "../types.ts";
import type { TeamSignInMethod } from "@shipbash/contracts/database-contract-types";

export interface CreateTeamSignInInput {
  method: TeamSignInMethod;
  loginUrl?: string | null;
  credential?: TeamSignInCredential | null;
}

export class ActorSignInsStore extends ActorTeamsStore {
  protected readonly signInKeyring: SignInKeyring | null;

  constructor(connection: StoreConnection, signInKeyring: SignInKeyring | null = null) {
    super(connection);
    this.signInKeyring = signInKeyring;
  }

  async listTeamSignIns(actor: TenantActor, teamId: string): Promise<TeamSignIn[]> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    return this.withActor(actor, async (sql) => listTeamSignIns(sql, {
      userId: actor.userId,
      teamId: scopedTeamId,
    }, this.signInKeyring));
  }

  async readTeamSignInSecrets(
    actor: TenantActor,
    teamId: string,
    signInId: string,
  ): Promise<TeamSignInSecrets | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedSignInId = nonEmpty(signInId, "signInId");
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      return readTeamSignInSecrets(
        sql,
        { teamId: scopedTeamId, signInId: scopedSignInId },
        this.signInKeyring,
      );
    });
  }

  async createTeamSignIn(
    actor: TenantActor,
    teamId: string,
    input: CreateTeamSignInInput,
  ): Promise<TeamSignIn> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const credential = normalizeCredential(input);
    const loginUrl = input.loginUrl ? new URL(nonEmpty(input.loginUrl, "loginUrl")).toString() : null;
    const keyring = this.#requireKeyring();
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      return insertTeamSignIn(sql, {
        teamId: scopedTeamId,
        createdBy: actor.userId,
        method: input.method,
        loginUrl,
        credential,
      }, keyring);
    });
  }

  async updateTeamSignIn(
    actor: TenantActor,
    teamId: string,
    signInId: string,
    input: UpdateTeamSignInInput,
  ): Promise<TeamSignIn | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedSignInId = nonEmpty(signInId, "signInId");
    if (input.consecutiveFailures !== undefined && !Number.isInteger(input.consecutiveFailures)) {
      throw new Error("consecutiveFailures must be an integer.");
    }
    const keyring = this.#requireKeyring();
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      if (input.credential !== undefined) {
        // The same rule create keeps, applied where the row already exists: a
        // credential on any other lane is material nothing would ever read.
        const method = await readTeamSignInMethod(sql, {
          teamId: scopedTeamId,
          signInId: scopedSignInId,
        });
        if (method !== null && method !== "email_password") {
          throw new Error("Only an email_password sign-in carries a credential.");
        }
      }
      return updateTeamSignIn(
        sql,
        { ...input, teamId: scopedTeamId, signInId: scopedSignInId },
        keyring,
      );
    });
  }

  /**
   * Folds away the row the Team already has for the account a leg just proved
   * under this method, when one exists, so the caller can tick the proved row
   * to that label without colliding with the unique index. Team Admin, because
   * it revokes a Team sign-in and moves Project bindings; the rebind and the
   * revoke share one transaction so they cannot come apart. No keyring: the
   * proved session stays sealed where it already is, on the row that survives.
   */
  async foldDuplicateTeamSignIn(
    actor: TenantActor,
    teamId: string,
    input: { method: TeamSignInMethod; label: string; newSignInId: string },
  ): Promise<TeamSignIn | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const newSignInId = nonEmpty(input.newSignInId, "newSignInId");
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      return foldDuplicateTeamSignIn(
        sql,
        { teamId: scopedTeamId, method: input.method, label: input.label, newSignInId },
      );
    });
  }

  async revokeTeamSignIn(
    actor: TenantActor,
    teamId: string,
    signInId: string,
  ): Promise<TeamSignIn | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedSignInId = nonEmpty(signInId, "signInId");
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      return revokeTeamSignIn(
        sql,
        { teamId: scopedTeamId, signInId: scopedSignInId },
        this.signInKeyring,
      );
    });
  }

  /**
   * Settles rows whose verification leg never came back. Membership is enough:
   * this writes no secret and makes no decision about the way in, it only stops
   * a row claiming a check is running when none is. The caller's rule decides
   * which ids are stranded (service/sign-in-reaper.ts).
   */
  async reapStrandedSignIns(
    actor: TenantActor,
    teamId: string,
    input: { signInIds: readonly string[]; strandedBefore: Date },
  ): Promise<string[]> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    if (input.signInIds.length === 0) return [];
    const ids = input.signInIds.map((signInId) => nonEmpty(signInId, "signInId"));
    return this.withTeamRole(actor, scopedTeamId, "member", async (sql) => {
      return reapStrandedSignIns(sql, {
        strandedBefore: input.strandedBefore,
        signInIds: ids,
        teamId: scopedTeamId,
      });
    });
  }

  async recordTeamSignInEvent(
    actor: TenantActor,
    teamId: string,
    input: TeamSignInEventInput,
  ): Promise<void> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    await this.withTeamRole(actor, scopedTeamId, "member", async (sql) => {
      await insertTeamSignInEvent(sql, {
        ...input,
        teamId: scopedTeamId,
        actorUserId: input.actor === "user" ? actor.userId : (input.actorUserId ?? null),
      });
    });
  }

  async bindProjectSignIn(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    signInId: string,
  ): Promise<ProjectSignInBinding> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedSignInId = nonEmpty(signInId, "signInId");
    return this.withProjectRole(actor, scopedTeamId, scopedProjectId, "admin", async (sql) => {
      return bindProjectSignIn(sql, {
        teamId: scopedTeamId,
        projectId: scopedProjectId,
        signInId: scopedSignInId,
      });
    });
  }

  async unbindProjectSignIn(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    signInId: string,
  ): Promise<boolean> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedSignInId = nonEmpty(signInId, "signInId");
    return this.withProjectRole(actor, scopedTeamId, scopedProjectId, "admin", async (sql) => {
      return unbindProjectSignIn(sql, {
        teamId: scopedTeamId,
        projectId: scopedProjectId,
        signInId: scopedSignInId,
      });
    });
  }

  async listProjectSignIns(
    actor: TenantActor,
    teamId: string,
    projectId: string,
  ): Promise<BoundSignIn[]> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    return this.withActor(actor, async (sql) => listProjectSignIns(sql, {
      userId: actor.userId,
      teamId: scopedTeamId,
      projectId: scopedProjectId,
    }, this.signInKeyring));
  }

  /** The owner moves this Project's verification runs onto a ready way in it has bound. */
  async chooseProjectRunSignIn(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    signInId: string,
  ): Promise<boolean> {
    const scope = { teamId: nonEmpty(teamId, "teamId"), projectId: nonEmpty(projectId, "projectId") };
    const scopedSignInId = nonEmpty(signInId, "signInId");
    return this.withProjectRole(actor, scope.teamId, scope.projectId, "admin", async (sql) => {
      return chooseProjectRunSignIn(sql, { ...scope, signInId: scopedSignInId });
    });
  }

  /** A way in just proved becomes the runs' when the Project has none yet; answers whether it is theirs. */
  async claimProjectRunSignIn(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    signInId: string,
  ): Promise<boolean> {
    const scope = { teamId: nonEmpty(teamId, "teamId"), projectId: nonEmpty(projectId, "projectId") };
    const scopedSignInId = nonEmpty(signInId, "signInId");
    return this.withProjectRole(actor, scope.teamId, scope.projectId, "admin", async (sql) => {
      return claimProjectRunSignIn(sql, { ...scope, signInId: scopedSignInId });
    });
  }

  #requireKeyring(): SignInKeyring {
    if (!this.signInKeyring) {
      throw new SignInCryptoError(
        "unconfigured",
        `Saving a sign-in needs ${SIGN_IN_ENCRYPTION_KEYS_VARIABLE}; nothing is stored unsealed.`,
      );
    }
    return this.signInKeyring;
  }
}

/**
 * A password sign-in without a credential would be a row nobody can use, and
 * the table refuses it; every other method carries its secret in the captured
 * session instead, so a credential there is a mistake worth naming.
 */
function normalizeCredential(input: CreateTeamSignInInput): TeamSignInCredential | null {
  if (input.method !== "email_password") {
    if (input.credential) throw new Error("Only an email_password sign-in carries a credential.");
    return null;
  }
  const credential = input.credential;
  if (!credential) throw new Error("An email_password sign-in needs an email and a password.");
  return {
    email: nonEmpty(credential.email, "credential.email"),
    password: nonEmpty(credential.password, "credential.password"),
    totpSecret: credential.totpSecret?.trim() || null,
  };
}
