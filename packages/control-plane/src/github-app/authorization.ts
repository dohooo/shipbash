/**
 * Connecting proves an installation through GitHub's authorization of the
 * App by the person connecting, whatever they signed in to ShipBash with.
 * The web flow's code is exchanged for their user-to-server token; the token
 * answers who they are and how much of an installation they can read, and
 * is then dropped — never stored, never used again. Every call is timed, and
 * a GitHub that does not answer reads as GitHub not answering.
 */
import type { App } from "@octokit/app";

import { GitHubSecurityError } from "./errors.ts";
import { githubStatus, timeLimited, withinTimeout } from "./reads.ts";

/** Where GitHub's authorization of the App comes back to: connecting finishes there. */
export const GITHUB_AUTHORIZATION_CALLBACK_PATH = "/api/github/oauth/callback";

type OAuthClient = Pick<App["oauth"], "getWebFlowAuthorizationUrl" | "getUserOctokit">;
type UserOctokit = Awaited<ReturnType<OAuthClient["getUserOctokit"]>>;

/** GitHub's page that asks the person to authorize the App, coming back to `redirectUrl` with `state`. */
export function authorizationUrl(oauth: OAuthClient, input: { state: string; redirectUrl: string }): string {
  return oauth.getWebFlowAuthorizationUrl({ state: input.state, redirectUrl: input.redirectUrl }).url;
}

export interface GitHubAuthorization {
  userId: number;
  /**
   * How many of the installation's repositories this person can read through
   * it; null when GitHub gives them none of it (a 404).
   */
  readableRepositoryCount(installationId: number): Promise<number | null>;
}

function unanswered(): GitHubSecurityError {
  return new GitHubSecurityError("installation_unavailable", "GitHub could not be read.");
}

/** The person behind an authorization code. A code GitHub will not exchange proves nothing. */
export async function authorizeWithCode(oauth: OAuthClient, code: string): Promise<GitHubAuthorization> {
  let octokit: UserOctokit;
  let userId: unknown;
  try {
    octokit = await withinTimeout(oauth.getUserOctokit({ code }));
    userId = (await octokit.request("GET /user", timeLimited())).data.id;
  } catch {
    throw new GitHubSecurityError("invalid_token", "GitHub did not accept the authorization.");
  }
  if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId < 1) {
    throw new GitHubSecurityError("invalid_token", "GitHub did not accept the authorization.");
  }
  return {
    userId,
    async readableRepositoryCount(installationId) {
      let count: unknown;
      try {
        const response = await octokit.request("GET /user/installations/{installation_id}/repositories", {
          installation_id: installationId,
          per_page: 1,
          ...timeLimited(),
        });
        count = response.data.total_count;
      } catch (error) {
        if (githubStatus(error) === 404) return null;
        throw unanswered();
      }
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw unanswered();
      return count;
    },
  };
}
