/**
 * The optional integrations a deployment offers, each read as a group: null
 * when the deployment configures none of it, so the composition roots build
 * nothing for it, its routes answer that it is not configured, the console
 * hides its entry points and its agent tools never mount. Half a group is a
 * mistake, reported with everything else at start.
 */
import { GITHUB_APP_ENVIRONMENT, type GitHubAppConfiguration, githubAppConfigurationFromEnvironment } from "./github-app.ts";
import { type ConfigurationReport, configuredGroup, optionalValue, parsed } from "./configuration-report.ts";
import { type SlackAppConfiguration, slackAppConfigurationFromEnvironment } from "./slack-app.ts";

type Environment = NodeJS.ProcessEnv;

const SLACK_ENVIRONMENT = ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"] as const;
const EMAIL_ENVIRONMENT = ["RESEND_API_KEY", "SHIPBASH_EMAIL_FROM"] as const;
const WAITLIST_ADMIN_PASSWORD = "WAITLIST_ADMIN_PASSWORD";

/**
 * Repository access through a GitHub App: the deployment's own App, or, on a
 * loopback console with none, one registered through GitHub's manifest flow
 * (github-app-provider.ts).
 */
export type GitHubIntegration =
  | { app: GitHubAppConfiguration }
  | { manifest: true };

/** The waiting list's admission email, sent through Resend from the deployment's verified sender. */
export interface EmailIntegration {
  resendApiKey: string;
  from: string;
}

export interface Integrations {
  slack: SlackAppConfiguration | null;
  github: GitHubIntegration | null;
  email: EmailIntegration | null;
  /** Guards the internal waiting list; null hides it. */
  waitlistAdminPassword: string | null;
}

function readSlack(environment: Environment, report: ConfigurationReport): SlackAppConfiguration | null {
  if (!configuredGroup(environment, SLACK_ENVIRONMENT, report)) return null;
  return parsed(report, () => slackAppConfigurationFromEnvironment(environment));
}

/** Whether the console answers on this machine only, where the manifest flow can register an App. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function readGitHub(environment: Environment, publicUrl: string | null, report: ConfigurationReport): GitHubIntegration | null {
  const app = configuredGroup(environment, GITHUB_APP_ENVIRONMENT, report)
    ? parsed(report, () => githubAppConfigurationFromEnvironment(environment))
    : null;
  if (app) return { app };
  if (publicUrl !== null && isLoopbackHost(new URL(publicUrl).hostname)) return { manifest: true };
  return null;
}

function readEmail(environment: Environment, report: ConfigurationReport): EmailIntegration | null {
  const resendApiKey = optionalValue(environment, "RESEND_API_KEY");
  const from = optionalValue(environment, "SHIPBASH_EMAIL_FROM");
  return configuredGroup(environment, EMAIL_ENVIRONMENT, report) && resendApiKey && from ? { resendApiKey, from } : null;
}

export function readIntegrations(
  environment: Environment,
  publicUrl: string | null,
  report: ConfigurationReport,
): Integrations {
  return {
    slack: readSlack(environment, report),
    github: readGitHub(environment, publicUrl, report),
    email: readEmail(environment, report),
    waitlistAdminPassword: optionalValue(environment, WAITLIST_ADMIN_PASSWORD),
  };
}
