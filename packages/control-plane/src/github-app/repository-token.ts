/**
 * A read-only installation token for one bound repository, minted on the host
 * where the GitHub App key is: the job API's `repositoryToken` hands it to a
 * task, and a conversation's host turn mints it for itself. A token GitHub
 * refuses because the install was deleted or suspended records the
 * revocation, so the runs created next carry no commit even before anyone
 * opens Settings.
 */
import type { App } from "@octokit/app";

import type { InternalStore } from "../store/internal-store.ts";
import type { ActivityExecutionInput } from "../types.ts";
import { probeInstallation } from "./reads.ts";
import { createGitHubInstallationToken } from "./token.ts";

export interface RepositoryToken {
  token: string;
  expiresAt: string;
}

type BoundRepository = Pick<NonNullable<ActivityExecutionInput["repository"]>, "githubInstallationId" | "installationId" | "githubRepositoryId">;

export async function mintRepositoryToken(
  app: App,
  store: Pick<InternalStore, "applyGitHubConnectionChangeInternal">,
  repository: BoundRepository,
): Promise<RepositoryToken> {
  const token = await createGitHubInstallationToken(app, {
    installationId: repository.installationId,
    repositoryId: repository.githubRepositoryId,
  }).catch(async (error: unknown) => {
    const probe = await probeInstallation(app, repository.installationId).catch(() => null);
    if (probe?.kind === "gone" || probe?.kind === "suspended") {
      await store.applyGitHubConnectionChangeInternal(repository.githubInstallationId, {
        kind: "revoked",
        at: probe.kind === "suspended" ? probe.at : new Date().toISOString(),
      });
    }
    throw error;
  });
  return token.use(async (value) => ({ token: value, expiresAt: token.expiresAt }));
}
