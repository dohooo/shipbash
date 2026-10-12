import { randomBytes } from "node:crypto";

import type { App } from "@octokit/app";

import { GitHubReadError, listReadableRepositories, readRepository } from "./github-app/reads.ts";
import type { GitHubAppProvider } from "./github-app-provider.ts";
import { readBinding, readStaleBindings, readTargetOf, type GitHubReadOutcome } from "./github-bindings.ts";
import {
  bindingView,
  type GitHubBindingView,
  type GitHubConnectionsInternal,
  type GitHubConnectionView,
  observedConnections,
} from "./github-connections.ts";
import { INSTALL_STATE_PATTERN, hashInstallState } from "./install-state.ts";
import {
  beginConnect,
  declineConnect,
  finishConnect,
  type GitHubAuthorizationOutcome,
  type GitHubConnectContext,
  type GitHubSetupRedirect,
} from "./github-tenant-service-connect.ts";
import {
  assertManifestCallbackShape,
  buildAppRegistration,
  fetchManifestConversion,
  parseManifestConversion,
  validateManifestConversion,
} from "./github-tenant-service-manifest.ts";
import type { ActorStore } from "./store/actor-store.ts";
import type { GitHubGateway, GitHubInstallRedirect } from "./api.ts";
import type { TenantActor } from "./types.ts";

const STATE_TTL_MS = 10 * 60 * 1_000;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;

type GitHubTenantStore = Pick<
  ActorStore,
  | "listTeams"
  | "createGitHubInstallationState"
  | "getPendingGitHubInstallationState"
  | "recordGitHubInstallationSetup"
  | "abandonGitHubInstallationState"
  | "createGitHubAppManifestState"
  | "getPendingGitHubAppManifestState"
  | "completeGitHubAppManifestState"
  | "completeGitHubInstallation"
  | "requestGitHubInstallation"
  | "listGitHubConnections"
  | "listGitHubBindingsOfConnection"
  | "getGitHubConnection"
  | "getGitHubBinding"
  | "bindGitHubRepository"
  | "unbindGitHubRepository"
  | "disconnectGitHub"
  | "findGitHubInstallationTeamSlug"
>;

type GitHubTenantApp = Pick<App, "eachRepository" | "getInstallationOctokit" | "getInstallationUrl" | "octokit" | "oauth">;

function validInstallationUrl(value: string, state: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/apps\/[A-Za-z0-9-]+\/installations\/new$/u.test(url.pathname) ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== state ||
    [...url.searchParams.keys()].some((key) => key !== "state")
  ) {
    throw new Error("GitHub returned an invalid App installation URL.");
  }
  return url.toString();
}

/** A preview finishes its own installs; a loopback or plain-HTTP deployment has no origin to hand back to. */
function returnOriginOf(publicBaseUrl: string): string | null {
  const url = new URL(publicBaseUrl);
  return url.protocol === "https:" ? url.origin : null;
}

/**
 * No GitHub App is configured on this deployment, so nothing that needs App
 * credentials (user lookup, repositories) can run. A deployment state, not a
 * bad request: routes answer it with a typed error, not an unhandled 500.
 */
export class GitHubAppUnavailableError extends Error {
  constructor() {
    super("GitHub App access is unavailable.");
    this.name = "GitHubAppUnavailableError";
  }
}

export class GitHubTenantService implements GitHubGateway {
  constructor(
    private readonly appProvider: GitHubAppProvider,
    private readonly store: GitHubTenantStore,
    private readonly internal: GitHubConnectionsInternal,
    private readonly publicBaseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async app(): Promise<GitHubTenantApp> {
    const app = await this.appProvider.getApp();
    if (!app) throw new GitHubAppUnavailableError();
    return app;
  }

  private async requireAdmin(actor: TenantActor, teamId: string): Promise<void> {
    const team = (await this.store.listTeams(actor)).find((entry) => entry.id === teamId);
    if (team?.role !== "admin") throw new Error("Team Admin required.");
  }

  /** Where Connect goes: GitHub's install page, or the local App registration when there is no App yet. */
  async installRedirect(actor: TenantActor, teamId: string, returnPath: string): Promise<GitHubInstallRedirect> {
    await this.requireAdmin(actor, teamId);
    const provider = await this.appProvider.status();
    const state = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();
    if (!provider.configured) {
      if (!provider.registrationAllowed) throw new GitHubAppUnavailableError();
      await this.store.createGitHubAppManifestState(actor, teamId, hashInstallState(state), expiresAt);
      const registration = buildAppRegistration(this.appProvider.registrationName(), this.publicBaseUrl, state);
      return { kind: "register_app", ...registration };
    }
    const app = await this.app();
    // The App's setup URL is fixed to one deployment; the origin that issued
    // this state is where the browser is sent back to finish.
    await this.store.createGitHubInstallationState(actor, teamId, {
      stateHash: hashInstallState(state),
      expiresAt,
      returnOrigin: returnOriginOf(this.publicBaseUrl),
      returnPath,
    });
    return { kind: "install_app", url: validInstallationUrl(await app.getInstallationUrl({ state }), state) };
  }

  /** The origin that issued a pending installation redirect, or null when it is unknown or expired. */
  async installationReturnOrigin(actor: TenantActor, state: string): Promise<string | null> {
    if (!INSTALL_STATE_PATTERN.test(state)) return null;
    const pending = await this.store.getPendingGitHubInstallationState(actor, hashInstallState(state));
    return pending?.returnOrigin ?? null;
  }

  async completeManifest(actor: TenantActor, input: { state: string; code: string }): Promise<{ teamId: string }> {
    assertManifestCallbackShape(input.state, input.code);
    const pending = await this.store.getPendingGitHubAppManifestState(actor, hashInstallState(input.state));
    if (!pending) throw new Error("GitHub App Manifest state is invalid, expired, or consumed.");
    const raw = await fetchManifestConversion(this.fetchImpl, input.code);
    const payload = parseManifestConversion(raw);
    const localApp = validateManifestConversion(payload);
    await this.appProvider.saveLocalApp(localApp);
    await this.store.completeGitHubAppManifestState(actor, pending.teamId, hashInstallState(input.state));
    return { teamId: pending.teamId };
  }

  private async connectContext(): Promise<GitHubConnectContext> {
    return { app: await this.app(), store: this.store, internal: this.internal, publicBaseUrl: this.publicBaseUrl };
  }

  /**
   * GitHub's setup redirect after an install, a change to one, or a request
   * for an owner's approval, started from the pane: where GitHub asks the
   * person to authorize the App, or null when no state of theirs names it.
   */
  async beginAuthorization(actor: TenantActor, setup: GitHubSetupRedirect): Promise<string | null> {
    return beginConnect(await this.connectContext(), actor, setup);
  }

  /** GitHub's authorization redirect: what the person's authorization proves, connected. */
  async completeAuthorization(actor: TenantActor, input: {
    state: string;
    code: string;
  }): Promise<{ returnPath: string; outcome: GitHubAuthorizationOutcome }> {
    return finishConnect(await this.connectContext(), actor, input);
  }

  /** The person declined GitHub's authorization: their state is spent. The pane to return to, or null. */
  async declineAuthorization(actor: TenantActor, state: string): Promise<string | null> {
    return declineConnect(this.store, actor, state);
  }

  /** The pane of the actor's Team that reads through this installation, for a redirect that carries no state. */
  async installationHome(actor: TenantActor, installationId: number): Promise<string | null> {
    const slug = await this.store.findGitHubInstallationTeamSlug(actor, installationId);
    return slug ? `/${encodeURIComponent(slug)}/settings/github` : null;
  }

  async connections(actor: TenantActor, teamId: string): Promise<GitHubConnectionView[]> {
    return observedConnections({
      app: await this.appProvider.getApp().catch(() => null),
      internal: this.internal,
      list: () => this.store.listGitHubConnections(actor, teamId),
    });
  }

  private async activeInstallationId(actor: TenantActor, teamId: string, connectionId: string): Promise<number> {
    const connection = await this.store.getGitHubConnection(actor, teamId, connectionId);
    if (connection?.status !== "active" || connection.installationId === null) {
      throw new Error("Active GitHub connection not found for Team.");
    }
    return connection.installationId;
  }

  async repositories(actor: TenantActor, teamId: string, connectionId: string) {
    const installationId = await this.activeInstallationId(actor, teamId, connectionId);
    return listReadableRepositories(await this.app(), installationId);
  }

  /** Binds the project to the repository, and reads it: a binding is never shown before its first read. */
  async bind(actor: TenantActor, teamId: string, projectId: string, input: {
    connectionId: string;
    repositoryId: number;
  }): Promise<GitHubBindingView> {
    const installationId = await this.activeInstallationId(actor, teamId, input.connectionId);
    const read = await readRepository(await this.app(), installationId, input.repositoryId);
    return bindingView(await this.store.bindGitHubRepository(actor, teamId, projectId, {
      connectionId: input.connectionId,
      read,
    }));
  }

  /** Reads the project's repository now. What the read found is in the binding returned. */
  async read(actor: TenantActor, teamId: string, projectId: string): Promise<GitHubBindingView> {
    const binding = await this.store.getGitHubBinding(actor, teamId, projectId);
    if (!binding) throw new Error("GitHub binding not found.");
    const target = readTargetOf(binding);
    if (!target) throw new Error("The GitHub connection must be reconnected before it can be read.");
    const outcome: GitHubReadOutcome = await readBinding(await this.app(), this.internal, target);
    if (outcome === "revoked") throw new Error("The GitHub connection must be reconnected before it can be read.");
    if (outcome === "failed") throw new GitHubReadError("installation_unavailable");
    const after = await this.store.getGitHubBinding(actor, teamId, projectId);
    if (!after) throw new Error("GitHub binding not found.");
    return bindingView(after);
  }

  async unbind(actor: TenantActor, teamId: string, projectId: string): Promise<void> {
    await this.store.unbindGitHubRepository(actor, teamId, projectId);
  }

  /** Forgets the connection and its bindings in ShipBash. The install on GitHub is the owner's to remove. */
  async disconnect(actor: TenantActor, teamId: string, connectionId: string): Promise<void> {
    await this.store.disconnectGitHub(actor, teamId, connectionId);
  }

  /** The schedules tick's read of every stale binding; nothing when no App is configured. */
  async readStaleRepositories(): Promise<Record<GitHubReadOutcome, number> | null> {
    const app = await this.appProvider.getApp().catch(() => null);
    return app ? readStaleBindings(app, this.internal) : null;
  }

  async resolveUser(login: string): Promise<{ id: number; login: string }> {
    const app = await this.app();
    const normalized = login.trim();
    if (!GITHUB_LOGIN_PATTERN.test(normalized)) throw new Error("GitHub login is invalid.");
    let response: Awaited<ReturnType<typeof app.octokit.request>>;
    try {
      response = await app.octokit.request("GET /users/{username}", { username: normalized });
    } catch {
      throw new Error("GitHub user was not found.");
    }
    if (
      response.data.type !== "User" ||
      !Number.isSafeInteger(response.data.id) || response.data.id < 1 ||
      !GITHUB_LOGIN_PATTERN.test(response.data.login)
    ) throw new Error("GitHub user was not found.");
    return { id: response.data.id, login: response.data.login };
  }
}
