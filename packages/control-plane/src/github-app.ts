// The GitHub App itself: the two environment values it is built from, and the
// App client every other module authenticates through. The rest lives in
// ./github-app/ — the security error, the identifier shapes, the installation
// ownership check and the ephemeral installation token each in their own
// module. The one-shot install state is not GitHub's: it is shared with Slack
// in ../install-state.ts.
import { App } from "@octokit/app";

export {
  type ValidatedGitHubInstallation,
  readGitHubInstallation,
} from "./github-app/installation.ts";
export {
  EphemeralGitHubInstallationToken,
  createGitHubInstallationToken,
} from "./github-app/token.ts";

/** The App's OAuth client: what connecting proves an installation with, by GitHub authorizing the person. */
export interface GitHubAppOAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface GitHubAppConfiguration {
  appId: number;
  privateKey: string;
  oauth: GitHubAppOAuthClient;
}

/** The four values a managed App is configured with, all of them or none. */
export const GITHUB_APP_ENVIRONMENT: readonly string[] = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
];

export function githubAppConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv,
): GitHubAppConfiguration {
  const missing = GITHUB_APP_ENVIRONMENT.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) throw new Error(`${missing.join(", ")} must be configured with the rest of the GitHub App.`);
  const appId = Number(environment.GITHUB_APP_ID);
  if (!Number.isSafeInteger(appId) || appId < 1) throw new Error("GITHUB_APP_ID must be a positive integer.");
  return {
    appId,
    privateKey: String(environment.GITHUB_APP_PRIVATE_KEY).replaceAll("\\n", "\n"),
    oauth: {
      clientId: String(environment.GITHUB_APP_CLIENT_ID).trim(),
      clientSecret: String(environment.GITHUB_APP_CLIENT_SECRET).trim(),
    },
  };
}

export function createGitHubApp(configuration: GitHubAppConfiguration): App {
  return new App({
    appId: configuration.appId,
    privateKey: configuration.privateKey,
    oauth: configuration.oauth,
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  });
}
