/**
 * An App installation as the App itself reads it: the account it is on, and
 * whether it is usable. Whether the person connecting may claim it is proved
 * elsewhere, by GitHub listing it among the installations their own
 * authorization of the App can reach.
 */
import type { App } from "@octokit/app";

import { GitHubSecurityError } from "./errors.ts";
import { assertPositiveInteger, isGitHubOwner } from "./identifiers.ts";

export interface ValidatedGitHubInstallation {
  id: number;
  accountId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
}

export async function readGitHubInstallation(
  app: Pick<App, "octokit">,
  installationId: number,
): Promise<ValidatedGitHubInstallation> {
  assertPositiveInteger(installationId, "GitHub installation ID");

  // biome-ignore lint/suspicious/noImplicitAnyLet: TypeScript types this evolving let from the assignment in the try block; naming the endpoint's response type would import @octokit/types.
  let installation;
  try {
    const response = await app.octokit.request(
      "GET /app/installations/{installation_id}",
      { installation_id: installationId },
    );
    installation = response.data;
  } catch {
    throw new GitHubSecurityError(
      "installation_unavailable",
      "The GitHub App installation is unavailable.",
    );
  }
  if (
    !installation.account ||
    installation.suspended_at ||
    installation.id !== installationId ||
    !Number.isSafeInteger(installation.account.id) ||
    installation.account.id < 1 ||
    (installation.repository_selection !== "all" &&
      installation.repository_selection !== "selected")
  ) {
    throw new GitHubSecurityError(
      "installation_unavailable",
      "The GitHub App installation is unavailable.",
    );
  }

  const account = installation.account;
  const accountLogin = "login" in account && typeof account.login === "string"
    ? account.login
    : undefined;
  if (!accountLogin || !isGitHubOwner(accountLogin)) {
    throw new GitHubSecurityError(
      "installation_forbidden",
      "The GitHub App installation account type is unsupported.",
    );
  }
  const accountType = installation.target_type;
  if (accountType !== "User" && accountType !== "Organization") {
    throw new GitHubSecurityError(
      "installation_forbidden",
      "The GitHub App installation account type is unsupported.",
    );
  }

  return {
    id: installation.id,
    accountId: account.id,
    accountLogin,
    accountType,
    repositorySelection: installation.repository_selection,
  };
}
