/**
 * Actor facet — Projects: listing, trusted access, and the project lifecycle
 * doors (create-by-URL, archive). Admin checks happen here; the aggregates
 * under src/store/ own the SQL.
 */
import { ActorSignInsStore } from "./actor-sign-ins.ts";
import type { AgentRuntime } from "@shipbash/contracts/model-contract";
import type { ProjectTrustedAccess, TenantActor, TenantProject } from "../types.ts";
import { nonEmpty, trustedAccessHeaderName } from "./normalize.ts";
import { normalizeProductionUrl } from "./production-url.ts";
import { createUrlProject } from "./project-create.ts";
import { archiveProject, getProject, listProjects, normalizeAgentRuntime } from "./project-lifecycle.ts";
import {
  getProjectTrustedAccess,
  revokeProjectTrustedAccess,
  updateProjectTrustedAccessVerification,
  upsertProjectTrustedAccess,
} from "./trusted-access.ts";

export class ActorProjectsStore extends ActorSignInsStore {
  async listProjects(actor: TenantActor, teamId: string): Promise<TenantProject[]> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    return this.withActor(actor, async (sql) => listProjects(sql, actor, scopedTeamId));
  }

  async getProject(
    actor: TenantActor,
    teamId: string,
    projectId: string,
  ): Promise<TenantProject | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    return this.withActor(actor, async (sql) => getProject(sql, actor, scopedTeamId, scopedProjectId));
  }

  async getProjectTrustedAccess(
    actor: TenantActor,
    teamId: string,
    projectId: string,
  ): Promise<ProjectTrustedAccess | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    return this.withActor(actor, async (sql) => getProjectTrustedAccess(sql, actor, scopedTeamId, scopedProjectId));
  }

  async upsertProjectTrustedAccess(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    input: {
      mode: ProjectTrustedAccess["mode"];
      headerName: string;
      secret: string;
    },
  ): Promise<ProjectTrustedAccess> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    if (input.mode !== "cloudflare_header") {
      throw new Error("mode must be cloudflare_header.");
    }
    const headerName = trustedAccessHeaderName(input.headerName);
    return this.withProjectRole(actor, scopedTeamId, scopedProjectId, "admin", async (sql) => {
      return upsertProjectTrustedAccess(sql, this.signInKeyring, actor, scopedTeamId, scopedProjectId, {
        mode: input.mode,
        headerName,
        secret: input.secret,
      });
    });
  }

  async updateProjectTrustedAccessVerification(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    input: {
      verified: boolean;
      /** The sealed value the verification opened: the write lands only while the row still holds it. */
      expectedSecretCiphertext: string;
      verifiedOrigin: string;
    },
  ): Promise<ProjectTrustedAccess | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const expected = nonEmpty(input.expectedSecretCiphertext, "expectedSecretCiphertext");
    const verifiedOrigin = new URL(nonEmpty(input.verifiedOrigin, "verifiedOrigin")).origin;
    return this.withProjectRole(actor, scopedTeamId, scopedProjectId, "admin", async (sql) => {
      return updateProjectTrustedAccessVerification(sql, actor, scopedTeamId, scopedProjectId, input, expected, verifiedOrigin);
    });
  }

  async revokeProjectTrustedAccess(
    actor: TenantActor,
    teamId: string,
    projectId: string,
  ): Promise<ProjectTrustedAccess> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    return this.withProjectRole(actor, scopedTeamId, scopedProjectId, "admin", async (sql) => {
      return revokeProjectTrustedAccess(sql, actor, scopedTeamId, scopedProjectId);
    });
  }

  /**
   * A Project for a Production URL, once per request key: a request that
   * repeats the key is answered with the Project the first one created.
   */
  async createUrlProject(
    actor: TenantActor,
    teamId: string,
    input: {
      id: string;
      name: string;
      productionUrl: string;
      agentRuntime?: AgentRuntime;
      clientIdempotencyKey: string;
    },
  ): Promise<TenantProject> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const project = {
      projectId: nonEmpty(input.id, "id"),
      name: nonEmpty(input.name, "name"),
      productionUrl: normalizeProductionUrl(input.productionUrl),
      agentRuntime: normalizeAgentRuntime(input.agentRuntime),
      clientKey: nonEmpty(input.clientIdempotencyKey, "clientIdempotencyKey"),
    };
    return this.withTeamRole(actor, scopedTeamId, "admin", async (sql) => {
      return createUrlProject(sql, actor, scopedTeamId, project);
    });
  }

  /** Soft-deletes a project: it disappears from listings while its runs and evidence stay in the database. */
  async archiveProject(
    actor: TenantActor,
    teamId: string,
    projectId: string,
  ): Promise<TenantProject> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    return this.withProjectRole(actor, scopedTeamId, scopedProjectId, "admin", async (sql) => {
      return archiveProject(sql, scopedTeamId, scopedProjectId);
    });
  }
}
