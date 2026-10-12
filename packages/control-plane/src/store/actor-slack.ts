/**
 * Actor facet — Slack. Reading the team's cards needs membership; minting,
 * redeeming, abandoning and disconnecting need Team admin, because a Slack
 * connection is the whole team's alerting route and not one member's to
 * replace. The install states are service-role only, so every door here runs
 * through withTrustedActor and proves the role explicitly. A Slack user's
 * sign-in reads and writes only the caller's own attempts and account, and
 * needs no role at all.
 */
import { ActorGitHubStore } from "./actor-github.ts";
import type { ConsumeInstallStateResult, PendingInstallState } from "../install-state.ts";
import { nonEmpty } from "./normalize.ts";
import {
  type SlackChannelBindingInput,
  type SlackDeliveryResult,
  type SlackTestSubject,
  bindSlackChannel,
  deleteSlackChannelBinding,
  recordSlackDeliveryResult,
  selectSlackBindableProject,
  selectSlackTestSubject,
} from "./slack-channel-bindings.ts";
import {
  type SlackSignInStart,
  type SlackSignInView,
  type SpentSlackSignIn,
  deleteSlackSignIn,
  insertSlackSignIn,
  recordSlackSignInIdentity,
  selectSlackSignIn,
  spendSlackSignInState,
} from "./slack-sign-ins.ts";
import { upsertSlackUserLink } from "./slack-user-links.ts";
import { selectSlackWorkspaceToken } from "./slack-workspace-token.ts";
import {
  type SlackConnections,
  type SlackWorkspaceConnection,
  consumeSlackInstallState,
  consumeSlackInstallStateAfterDenial,
  deleteSlackWorkspace,
  discardSlackInstallStates,
  insertSlackInstallState,
  revokeSlackWorkspaces,
  selectPendingSlackInstall,
  selectSlackConnections,
  upsertSlackWorkspace,
} from "./slack-workspaces.ts";
import { SIGN_IN_ENCRYPTION_KEYS_VARIABLE, SignInCryptoError } from "../sign-in-crypto.ts";
import type { SlackInstallation } from "../slack-app.ts";
import type { SlackSignInIdentity } from "../slack-sign-in.ts";
import type { TenantActor } from "../types.ts";

export class ActorSlackStore extends ActorGitHubStore {
  async listSlackConnections(actor: TenantActor, teamId: string): Promise<SlackConnections> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    return this.withTeamRole(actor, scopedTeamId, "member", async (sql) => {
      return selectSlackConnections(sql, scopedTeamId);
    });
  }

  async createSlackInstallState(
    actor: TenantActor,
    record: PendingInstallState,
    returnPath: string,
  ): Promise<void> {
    const scopedTeamId = nonEmpty(record.teamId, "teamId");
    await this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      await insertSlackInstallState(sql, {
        teamId: scopedTeamId,
        userId: actor.userId,
        stateHash: record.stateHash,
        expiresAt: record.expiresAt,
        returnPath,
      });
    });
  }

  /** Reads a pending redirect without spending it, so an error can still land on the pane. */
  async pendingSlackInstall(
    actor: TenantActor,
    stateHash: string,
  ): Promise<{ teamId: string; returnPath: string } | null> {
    return this.withTrustedActor(actor, async (sql) =>
      selectPendingSlackInstall(sql, { userId: actor.userId, stateHash }));
  }

  /** Redeems the redirect's state. The role is proven against the team the state names. */
  async consumeSlackInstallState(
    actor: TenantActor,
    input: { stateHash: string; expectedUserId: string; now: string },
  ): Promise<ConsumeInstallStateResult> {
    return this.withTrustedActor(actor, async (sql) => {
      const consumed = await consumeSlackInstallState(sql, input);
      if (consumed.status === "ok") {
        await this.requireTeamRole(sql, actor, consumed.record.teamId, "admin");
      }
      return consumed;
    });
  }

  async completeSlackInstall(
    actor: TenantActor,
    teamId: string,
    installation: SlackInstallation,
  ): Promise<SlackWorkspaceConnection> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const keyring = this.#requireKeyring();
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      return upsertSlackWorkspace(sql, keyring, {
        teamId: scopedTeamId,
        userId: actor.userId,
        installation,
      });
    });
  }

  /** The redirect came back refused. Only the state it names is spent. */
  async denySlackInstall(actor: TenantActor, stateHash: string): Promise<void> {
    await this.withTrustedActor(actor, async (sql) => {
      await consumeSlackInstallStateAfterDenial(sql, { userId: actor.userId, stateHash });
    });
  }

  async abandonSlackInstall(actor: TenantActor, teamId: string): Promise<void> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    await this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      await discardSlackInstallStates(sql, scopedTeamId);
    });
  }

  /** Forgets the workspace and returns its bot token, or null when there was no such card. */
  async disconnectSlackWorkspace(
    actor: TenantActor,
    teamId: string,
    workspaceId: string,
  ): Promise<string | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      return deleteSlackWorkspace(sql, this.signInKeyring, {
        teamId: scopedTeamId,
        workspaceId,
      });
    });
  }

  /**
   * The token one Slack call runs on. Null means this team has no such
   * workspace, or Slack has already stopped honouring it — either way there is
   * nothing to call Slack with, and the caller says so without a second read.
   */
  async openSlackWorkspaceToken(
    actor: TenantActor,
    teamId: string,
    workspaceId: string,
  ): Promise<{ botToken: string; slackTeamId: string } | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const keyring = this.#requireKeyring();
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      return selectSlackWorkspaceToken(sql, keyring, { teamId: scopedTeamId, workspaceId });
    });
  }

  /**
   * Slack answered a call with a dead token. This is the webhook's own
   * statement reached from the other direction: a `tokens_revoked` event that
   * never arrived must not leave the pane reporting a connection as live.
   */
  async revokeSlackWorkspaceAfterRefusal(
    actor: TenantActor,
    teamId: string,
    slackTeamId: string,
  ): Promise<void> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    await this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      await revokeSlackWorkspaces(sql, slackTeamId);
    });
  }

  /** Where the test message goes and what it names, or null when the project does not alert into that channel. */
  async slackTestSubject(
    actor: TenantActor,
    teamId: string,
    route: { projectId: string; channelId: string },
  ): Promise<SlackTestSubject | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      return selectSlackTestSubject(sql, {
        ...route,
        teamId: scopedTeamId,
        userId: actor.userId,
      });
    });
  }

  /** Whether this team has the project a channel is being chosen for. */
  async slackBindableProject(actor: TenantActor, teamId: string, projectId: string): Promise<boolean> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      return selectSlackBindableProject(sql, { teamId: scopedTeamId, projectId });
    });
  }

  /** An admin added this channel to the ones the project alerts into. True when the route is new. */
  async bindSlackChannel(actor: TenantActor, input: SlackChannelBindingInput): Promise<boolean> {
    const scopedTeamId = nonEmpty(input.teamId, "teamId");
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      return bindSlackChannel(sql, { ...input, teamId: scopedTeamId });
    });
  }

  /** How one message to the channel this project is already bound to ended. */
  async recordSlackDeliveryResult(actor: TenantActor, result: SlackDeliveryResult): Promise<void> {
    const scopedTeamId = nonEmpty(result.teamId, "teamId");
    await this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      await recordSlackDeliveryResult(sql, { ...result, teamId: scopedTeamId });
    });
  }

  /** The project stops alerting into this channel. A route that is already gone is the asked-for state. */
  async unbindSlackChannel(
    actor: TenantActor,
    teamId: string,
    route: { projectId: string; channelId: string },
  ): Promise<void> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    await this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      await deleteSlackChannelBinding(sql, { ...route, teamId: scopedTeamId });
    });
  }

  async startSlackSignIn(actor: TenantActor, start: SlackSignInStart): Promise<void> {
    await this.withTrustedActor(actor, async (sql) => {
      await insertSlackSignIn(sql, { ...start, userId: actor.userId });
    });
  }

  /** The caller's attempt this redirect's state belongs to, spent; null when it is gone or someone else's. */
  async spendSlackSignInState(actor: TenantActor, stateHash: string): Promise<SpentSlackSignIn | null> {
    return this.withTrustedActor(actor, async (sql) => spendSlackSignInState(sql, { userId: actor.userId, stateHash }));
  }

  /** The Slack identity a verified id_token named, for the caller to confirm; false when the attempt is gone. */
  async recordSlackSignIn(actor: TenantActor, signInId: string, identity: SlackSignInIdentity): Promise<boolean> {
    return this.withTrustedActor(actor, async (sql) =>
      recordSlackSignInIdentity(sql, { userId: actor.userId, id: signInId, identity }),
    );
  }

  async readSlackSignIn(actor: TenantActor, signInId: string): Promise<SlackSignInView | null> {
    return this.withTrustedActor(actor, async (sql) => selectSlackSignIn(sql, { userId: actor.userId, id: signInId }));
  }

  /**
   * The Slack user the caller's sign-in verified is the caller from now on.
   * Only an attempt the caller started, and Slack answered, can be confirmed,
   * once; false when there is none. The links are service-role only, so the
   * write is trusted and bound to the caller's own account.
   */
  async linkSlackUser(actor: TenantActor, signInId: string): Promise<boolean> {
    return this.withTrustedActor(actor, async (sql) => {
      const slackUser = await deleteSlackSignIn(sql, { userId: actor.userId, id: signInId });
      if (!slackUser) return false;
      await upsertSlackUserLink(sql, { ...slackUser, userId: actor.userId });
      return true;
    });
  }

  #requireKeyring() {
    if (!this.signInKeyring) {
      throw new SignInCryptoError(
        "unconfigured",
        `Storing a Slack bot token needs ${SIGN_IN_ENCRYPTION_KEYS_VARIABLE}; nothing is stored unsealed.`,
      );
    }
    return this.signInKeyring;
  }
}
