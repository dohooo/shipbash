/**
 * Actor facet — GitHub: the App handshake state doors, the team's
 * connections and the repository each project reads. Reading the pane needs
 * membership; minting, redeeming, binding and disconnecting need Team admin,
 * because a connection is the whole team's way into its code.
 */
import { ActorProjectsStore } from "./actor-projects.ts";
import type {
  GitHubAccountType,
  GitHubBinding,
  GitHubInstallation,
  GitHubInstallationInput,
  GitHubInstallationState,
  GitHubRead,
  GitHubRedirectState,
  GitHubSetup,
  ProjectRepository,
  TenantActor,
  TenantProject,
} from "../types.ts";
import {
  completeGitHubInstallationRow,
  deleteGitHubConnection,
  requestGitHubInstallationRow,
  selectGitHubConnection,
  selectGitHubConnections,
  selectInstallationTeamSlug,
} from "./github-installations.ts";
import {
  abandonGitHubInstallationState,
  consumeGitHubAppManifestState,
  insertGitHubAppManifestState,
  insertGitHubInstallationState,
  recordGitHubInstallationSetup,
  selectPendingGitHubAppManifestState,
  selectPendingGitHubInstallationState,
} from "./github-states.ts";
import { nonEmpty } from "./normalize.ts";
import { normalizeProductionUrl } from "./production-url.ts";
import { updateProject } from "./project-lifecycle.ts";
import {
  bindProjectRepository,
  deleteProjectRepository,
  listProjectRepositories,
  selectGitHubBindings,
} from "./project-repositories.ts";

export class ActorGitHubStore extends ActorProjectsStore {
  async createGitHubInstallationState(
    actor: TenantActor,
    teamId: string,
    input: { stateHash: string; expiresAt: string; returnOrigin: string | null; returnPath: string },
  ): Promise<GitHubInstallationState> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      return insertGitHubInstallationState(sql, { teamId: scopedTeamId, userId: actor.userId, ...input });
    });
  }

  /** The actor's pending install state: the one this hash names, or with no hash their newest. */
  async getPendingGitHubInstallationState(
    actor: TenantActor,
    stateHash: string | null,
  ): Promise<GitHubInstallationState | null> {
    return this.withTrustedActor(actor, async (sql) => selectPendingGitHubInstallationState(
      sql, { userId: actor.userId, stateHash },
    ));
  }

  /** GitHub's setup redirect recorded on the actor's pending state, under the authorization step's new hash. */
  async recordGitHubInstallationSetup(
    actor: TenantActor,
    input: { stateHash: string | null; nextStateHash: string; setup: GitHubSetup },
  ): Promise<GitHubInstallationState | null> {
    return this.withTrustedActor(actor, async (sql) => recordGitHubInstallationSetup(
      sql, { userId: actor.userId, ...input },
    ));
  }

  /** Spends the actor's state after they declined GitHub's authorization; the pane to return to, or null. */
  async abandonGitHubInstallationState(actor: TenantActor, stateHash: string): Promise<string | null> {
    return this.withTrustedActor(actor, async (sql) => abandonGitHubInstallationState(
      sql, { userId: actor.userId, stateHash },
    ));
  }

  async createGitHubAppManifestState(
    actor: TenantActor,
    teamId: string,
    stateHash: string,
    expiresAt: string,
  ): Promise<GitHubRedirectState> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      return insertGitHubAppManifestState(sql, { teamId: scopedTeamId, userId: actor.userId, stateHash, expiresAt });
    });
  }

  async getPendingGitHubAppManifestState(
    actor: TenantActor,
    stateHash: string,
  ): Promise<GitHubRedirectState | null> {
    return this.withTrustedActor(actor, async (sql) => selectPendingGitHubAppManifestState(
      sql, { userId: actor.userId, stateHash },
    ));
  }

  async completeGitHubAppManifestState(
    actor: TenantActor,
    teamId: string,
    stateHash: string,
  ): Promise<void> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    await this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      await consumeGitHubAppManifestState(sql, {
        teamId: scopedTeamId, userId: actor.userId, stateHash,
      });
    });
  }

  async completeGitHubInstallation(
    actor: TenantActor,
    teamId: string,
    stateHash: string,
    input: GitHubInstallationInput,
  ): Promise<GitHubInstallation> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      return completeGitHubInstallationRow(sql, {
        teamId: scopedTeamId, userId: actor.userId, stateHash, installation: input,
      });
    });
  }

  async requestGitHubInstallation(
    actor: TenantActor,
    teamId: string,
    stateHash: string,
    account: { id: number; login: string; type: GitHubAccountType },
  ): Promise<void> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    await this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      await requestGitHubInstallationRow(sql, {
        teamId: scopedTeamId, userId: actor.userId, stateHash, account,
      });
    });
  }

  /** The team's connections and every binding made through them. */
  async listGitHubConnections(
    actor: TenantActor,
    teamId: string,
  ): Promise<{ connections: GitHubInstallation[]; bindings: GitHubBinding[] }> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    return this.withTeamRole(actor, scopedTeamId, "member", async (sql) => ({
      connections: await selectGitHubConnections(sql, scopedTeamId),
      bindings: await selectGitHubBindings(sql, { teamId: scopedTeamId }),
    }));
  }

  /** One connection's bindings, for an admin who just reconnected it. */
  async listGitHubBindingsOfConnection(
    actor: TenantActor,
    teamId: string,
    connectionId: string,
  ): Promise<GitHubBinding[]> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => (
      selectGitHubBindings(sql, { teamId: scopedTeamId, connectionId: nonEmpty(connectionId, "connectionId") })
    ));
  }

  /** One connection, for an admin about to read or bind through it. */
  async getGitHubConnection(
    actor: TenantActor,
    teamId: string,
    connectionId: string,
  ): Promise<GitHubInstallation | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => (
      selectGitHubConnection(sql, scopedTeamId, connectionId)
    ));
  }

  /** The project's binding, for an admin about to read it. */
  async getGitHubBinding(
    actor: TenantActor,
    teamId: string,
    projectId: string,
  ): Promise<GitHubBinding | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => (
      (await selectGitHubBindings(sql, { teamId: scopedTeamId, projectId: nonEmpty(projectId, "projectId") }))[0] ?? null
    ));
  }

  async bindGitHubRepository(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    input: { connectionId: string; read: GitHubRead },
  ): Promise<GitHubBinding> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      const connection = await selectGitHubConnection(sql, scopedTeamId, input.connectionId);
      if (connection?.status !== "active") throw new Error("Active GitHub connection not found for Team.");
      await bindProjectRepository(sql, { teamId: scopedTeamId, projectId: scopedProjectId, ...input });
      const [binding] = await selectGitHubBindings(sql, { teamId: scopedTeamId, projectId: scopedProjectId });
      if (!binding) throw new Error("GitHub binding not found.");
      return binding;
    });
  }

  async unbindGitHubRepository(actor: TenantActor, teamId: string, projectId: string): Promise<void> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    await this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      await deleteProjectRepository(sql, scopedTeamId, projectId);
    });
  }

  async disconnectGitHub(actor: TenantActor, teamId: string, connectionId: string): Promise<void> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    await this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      await deleteGitHubConnection(sql, scopedTeamId, connectionId);
    });
  }

  /** The slug of the actor's Team that reads through this installation, or null. */
  async findGitHubInstallationTeamSlug(actor: TenantActor, installationId: number): Promise<string | null> {
    return this.withTrustedActor(actor, async (sql) => selectInstallationTeamSlug(sql, {
      userId: actor.userId, installationId,
    }));
  }

  async listProjectRepositories(
    actor: TenantActor,
    teamId: string,
    projectId?: string,
  ): Promise<ProjectRepository[]> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = projectId ? nonEmpty(projectId, "projectId") : null;
    return this.withActor(actor, async (sql) => listProjectRepositories(sql, actor, scopedTeamId, scopedProjectId));
  }

  async getProjectRepository(
    actor: TenantActor,
    teamId: string,
    projectId: string,
  ): Promise<ProjectRepository | null> {
    const rows = await this.listProjectRepositories(actor, teamId, projectId);
    return rows[0] ?? null;
  }

  async updateProject(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    input: {
      name?: string;
      productionUrl?: string;
      testingContext?: string | null;
      lifecycleStatus?: TenantProject["lifecycleStatus"];
    },
  ): Promise<TenantProject> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const name = input.name === undefined ? null : nonEmpty(input.name, "name");
    const productionUrl = input.productionUrl === undefined
      ? null
      : normalizeProductionUrl(input.productionUrl);
    const testingContext = input.testingContext === undefined
      ? undefined
      : input.testingContext?.trim() || null;
    if (testingContext && testingContext.length > 20_000) {
      throw new Error("testingContext exceeds 20000 characters.");
    }
    return this.withProjectRole(actor, scopedTeamId, scopedProjectId, "admin", async (sql) => {
      return updateProject(sql, actor, scopedTeamId, scopedProjectId, input, name, productionUrl, testingContext);
    });
  }
}
