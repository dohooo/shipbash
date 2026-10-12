/**
 * Everything the Slack app needs Slack itself for: the URL an admin
 * authorizes at, the redirect that comes back from it, telling Slack a token
 * is finished, and a Slack user's Sign in with Slack. Reading the team's
 * cards and abandoning a pending install are plain store reads and writes, so
 * they go straight to the store rather than through a gateway that would only
 * pass them on.
 */
import { randomBytes } from "node:crypto";

import type { JWTVerifyGetKey } from "jose";

import {
  INSTALL_STATE_PATTERN,
  type InstallStateStore,
  type PendingInstallState,
  consumeInstallState,
  hashInstallState,
  issueInstallState,
} from "./install-state.ts";
import {
  type SlackAppConfiguration,
  completeSlackInstall,
  revokeSlackToken,
  slackAuthorizeUrl,
} from "./slack-app.ts";
import {
  type SlackChannelList,
  deliverSlackTestMessage,
  listSlackChannels,
  readySlackChannel,
} from "./slack-channels.ts";
import {
  SLACK_SIGN_IN_KEYS,
  SlackSignInError,
  completeSlackSignIn,
  slackSignInUrl,
} from "./slack-sign-in.ts";
import { SlackNotDeliveringError, type SlackWorkspaceDoor, inSlackWorkspace } from "./slack-workspace-door.ts";
import type { SlackDeliveryError } from "@shipbash/contracts/database-contract-types";
import type { ActorStore } from "./store/actor-store.ts";
import type { SlackGateway } from "./api/gateways.ts";
import type { TenantActor } from "./types.ts";

type SlackTenantStore = Pick<
  ActorStore,
  | "completeSlackInstall"
  | "consumeSlackInstallState"
  | "createSlackInstallState"
  | "denySlackInstall"
  | "disconnectSlackWorkspace"
  | "bindSlackChannel"
  | "openSlackWorkspaceToken"
  | "pendingSlackInstall"
  | "recordSlackDeliveryResult"
  | "recordSlackSignIn"
  | "revokeSlackWorkspaceAfterRefusal"
  | "slackBindableProject"
  | "slackTestSubject"
  | "spendSlackSignInState"
  | "startSlackSignIn"
>;

/** Long enough to sign in to Slack and read the confirm screen: the install state's window. */
const SIGN_IN_TTL_MS = 10 * 60 * 1_000;

/** Where Slack sends the browser back. It must match the app's configured redirect exactly. */
export function slackRedirectUri(publicBaseUrl: string): string {
  return new URL("/api/slack/oauth/callback", publicBaseUrl).toString();
}

/** Where Sign in with Slack sends the browser back; one of the app's configured redirects too. */
function slackSignInRedirectUri(publicBaseUrl: string): string {
  return new URL("/api/slack/sign-in/callback", publicBaseUrl).toString();
}

export class SlackTenantService implements SlackGateway {
  constructor(
    private readonly configuration: SlackAppConfiguration,
    private readonly store: SlackTenantStore,
    private readonly publicBaseUrl: string,
    /** What an id_token's signature is checked against: Slack's published keys. */
    private readonly signInKeys: JWTVerifyGetKey = SLACK_SIGN_IN_KEYS,
  ) {}

  /**
   * The state store the shared handshake writes through. The team the install
   * is for travels in the record and the address it was started from travels
   * beside it, because Slack's redirect names neither.
   */
  #states(actor: TenantActor, returnPath: string): InstallStateStore {
    return {
      save: (record: PendingInstallState) =>
        this.store.createSlackInstallState(actor, record, returnPath),
      consume: (input) => this.store.consumeSlackInstallState(actor, input),
    };
  }

  async authorizeUrl(actor: TenantActor, teamId: string, returnPath: string): Promise<string> {
    const issued = await issueInstallState(this.#states(actor, returnPath), {
      userId: actor.userId,
      teamId,
    });
    return slackAuthorizeUrl({
      configuration: this.configuration,
      state: issued.state,
      redirectUri: slackRedirectUri(this.publicBaseUrl),
    });
  }

  /** The address a pending install was started from, or null when it is unknown or spent. */
  async installReturn(actor: TenantActor, state: string): Promise<string | null> {
    const pending = await this.store.pendingSlackInstall(actor, hashInstallState(state));
    return pending?.returnPath ?? null;
  }

  async deny(actor: TenantActor, state: string): Promise<void> {
    await this.store.denySlackInstall(actor, hashInstallState(state));
  }

  async complete(
    actor: TenantActor,
    input: { state: string; code: string; returnPath: string },
  ): Promise<void> {
    const state = await consumeInstallState(this.#states(actor, input.returnPath), {
      state: input.state,
      expectedUserId: actor.userId,
    });
    const installation = await completeSlackInstall({
      configuration: this.configuration,
      code: input.code,
      redirectUri: slackRedirectUri(this.publicBaseUrl),
    });
    await this.store.completeSlackInstall(actor, state.teamId, installation);
  }

  /**
   * A Slack user's sign-in, started by the ShipBash account they are signed
   * in as. The workspace and channel are where @ShipBash asked from: Slack
   * opens on that workspace, and the person goes back to that channel.
   */
  async signInUrl(actor: TenantActor, hint: { slackTeamId: string; channelId: string }): Promise<string> {
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    await this.store.startSlackSignIn(actor, {
      stateHash: hashInstallState(state),
      nonce,
      ...hint,
      expiresAt: new Date(Date.now() + SIGN_IN_TTL_MS).toISOString(),
    });
    return slackSignInUrl({
      configuration: this.configuration,
      state,
      nonce,
      slackTeamId: hint.slackTeamId,
      redirectUri: slackSignInRedirectUri(this.publicBaseUrl),
    });
  }

  /**
   * Slack's redirect back. The state is spent before Slack is asked anything,
   * so it is good for one redirect, and only from the account that started
   * it. The identity recorded is the one Slack's verified id_token names, in
   * the workspace @ShipBash asked from. Answers with the attempt to confirm.
   */
  async completeSignIn(actor: TenantActor, input: { state: string; code: string }): Promise<string> {
    const spent = INSTALL_STATE_PATTERN.test(input.state)
      ? await this.store.spendSlackSignInState(actor, hashInstallState(input.state))
      : null;
    if (!spent) throw new SlackSignInError("expired", "This sign-in has expired or was already used.");
    const identity = await completeSlackSignIn({
      configuration: this.configuration,
      code: input.code,
      redirectUri: slackSignInRedirectUri(this.publicBaseUrl),
      nonce: spent.nonce,
      keys: this.signInKeys,
    });
    if (identity.slackTeamId !== spent.slackTeamId) {
      throw new SlackSignInError("workspace", "Slack signed in to another workspace than the one @ShipBash asked from.");
    }
    if (!(await this.store.recordSlackSignIn(actor, spent.id, identity))) {
      throw new SlackSignInError("expired", "This sign-in was replaced by a newer one.");
    }
    return spent.id;
  }

  /** A card that is already gone is the state the caller asked for, so this is idempotent. */
  async disconnect(actor: TenantActor, teamId: string, workspaceId: string): Promise<void> {
    const botToken = await this.store.disconnectSlackWorkspace(actor, teamId, workspaceId);
    if (botToken) await revokeSlackToken(botToken);
  }

  async channels(
    actor: TenantActor,
    teamId: string,
    workspaceId: string,
  ): Promise<SlackChannelList> {
    return this.#inWorkspace(actor, teamId, workspaceId, listSlackChannels);
  }

  /**
   * Adds a channel to the ones a project alerts into. Slack is asked about the
   * channel first, and ShipBash joins it when it is public, so a channel
   * nothing could be posted in answers with the reason and is never saved. A
   * route that is new is then told which project alerts into it; one the
   * project already had is not.
   */
  async bindChannel(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    input: { workspaceId: string; channelId: string },
  ): Promise<SlackDeliveryError | null> {
    if (!(await this.store.slackBindableProject(actor, teamId, projectId))) {
      throw new Error("The project was not found.");
    }
    const ready = await this.#inWorkspace(actor, teamId, input.workspaceId, (token) =>
      readySlackChannel(token, input.channelId));
    if (ready.channel === null) return ready.refused;
    const added = await this.store.bindSlackChannel(actor, {
      teamId,
      workspaceId: input.workspaceId,
      projectId,
      channel: ready.channel,
      boundBy: actor.userId,
    });
    if (added) await this.#announce(actor, teamId, { projectId, channelId: ready.channel.id });
    return null;
  }

  /**
   * The test message, sent into a channel the moment it is saved. The save
   * already stands, so how this message ended belongs to the binding and never
   * to the save's answer: a refusal is recorded as a test's is and reads as
   * one on the row, a token Slack stopped honouring has already marked the
   * workspace revoked, and anything else — a call whose outcome is unknown, a
   * record that could not be written — is logged and records nothing.
   */
  async #announce(
    actor: TenantActor,
    teamId: string,
    route: { projectId: string; channelId: string },
  ): Promise<void> {
    try {
      await this.testBinding(actor, teamId, route);
    } catch (error) {
      if (error instanceof SlackNotDeliveringError) return;
      console.error("[slack] a saved channel's announcement did not finish:", error);
    }
  }

  /**
   * The test message, to one channel the project is bound to. How it ended is
   * recorded the way an alert's delivery is, so the route says what happened
   * to whichever message reached the channel last, and the binding never moves.
   */
  async testBinding(
    actor: TenantActor,
    teamId: string,
    route: { projectId: string; channelId: string },
  ): Promise<SlackDeliveryError | null> {
    const subject = await this.store.slackTestSubject(actor, teamId, route);
    if (!subject) throw new Error("The project's Slack binding was not found.");
    const error = await this.#inWorkspace(actor, teamId, subject.workspaceId, (token) =>
      deliverSlackTestMessage(token, subject));
    await this.store.recordSlackDeliveryResult(actor, { ...route, teamId, error });
    return error;
  }

  /** This admin's way through the one door; the sender has its own. */
  #door(actor: TenantActor, teamId: string, workspaceId: string): SlackWorkspaceDoor {
    return {
      open: () => this.store.openSlackWorkspaceToken(actor, teamId, workspaceId),
      revoke: (slackTeamId) =>
        this.store.revokeSlackWorkspaceAfterRefusal(actor, teamId, slackTeamId),
    };
  }

  async #inWorkspace<T>(
    actor: TenantActor,
    teamId: string,
    workspaceId: string,
    call: (token: string) => Promise<T>,
  ): Promise<T> {
    return inSlackWorkspace(this.#door(actor, teamId, workspaceId), call);
  }
}
