/**
 * The one reader of a deployment's configuration: every variable an operator
 * sets, read once at a process's entry and refused at once with everything
 * it lacks. The entry points call it — the dev stack's preflight and the
 * local service on a laptop; the console's resources, Workflows and routes
 * on Vercel — and hand what it returns down, so nothing past them reads the
 * environment to decide what is configured.
 *
 * Required everywhere: the agent services (contracts agent-model.mjs), the
 * console's public URL, the actor signing secret and the sign-in keyring. A
 * laptop also needs a way to sign in to local Supabase; a hosted deployment
 * also needs what its console keeps state and creates Sandboxes with
 * (configuration-hosted.ts). The integrations are optional, each switched
 * off by leaving its group unset (configuration-integrations.ts), and so
 * are the waiting list and the monthly Run quota.
 */
import { type AgentServices, readAgentServices } from "@shipbash/contracts/runtime/agent-model.mjs";

import { type HostedConfiguration, readHosted } from "./configuration-hosted.ts";
import { type Integrations, readIntegrations } from "./configuration-integrations.ts";
import {
  type ConfigurationReport,
  ConfigurationError,
  hasProblems,
  optionalValue,
  parsed,
  requiredValue,
} from "./configuration-report.ts";
import { configuredPublicUrl } from "./public-url.ts";
import { SIGN_IN_ENCRYPTION_KEYS_VARIABLE, type SignInKeyring, signInKeyringFromEnvironment } from "./sign-in-crypto.ts";
import { configuredLocalOAuthProviders, type LocalOAuthProvider } from "./supervisor/oauth-providers.ts";

export { ConfigurationError } from "./configuration-report.ts";
export type { HostedConfiguration } from "./configuration-hosted.ts";
export type { EmailIntegration, GitHubIntegration, Integrations } from "./configuration-integrations.ts";

/** Where a process runs: the dev stack on a laptop, or a Vercel deployment. */
export type Runtime = "local" | "hosted";

export interface Configuration {
  runtime: Runtime;
  agents: AgentServices;
  /** The console's origin. */
  publicUrl: string;
  actorSigningSecret: string;
  signInKeyring: SignInKeyring;
  /** The ways in local Supabase Auth offers; a hosted deployment configures its own in Supabase. */
  signInProviders: LocalOAuthProvider[];
  /** Whether a new account waits on the waiting list until it is let in. */
  waitlist: boolean;
  /** Whether each team is held to its monthly Run quota (store/run-quota.ts). */
  runQuota: boolean;
  integrations: Integrations;
  hosted: HostedConfiguration | null;
}

type Environment = NodeJS.ProcessEnv;

export function configurationRuntime(environment: Environment): Runtime {
  return environment.VERCEL === "1" ? "hosted" : "local";
}

function publicUrl(environment: Environment, report: ConfigurationReport): string | null {
  const configured = configuredPublicUrl(environment);
  if (!configured) {
    report.missing.push("SHIPBASH_PUBLIC_URL");
    return null;
  }
  const url = URL.canParse(configured) ? new URL(configured) : null;
  const origin = url && (url.protocol === "https:" || url.protocol === "http:")
    && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  if (url && origin) return url.origin;
  report.invalid.push("SHIPBASH_PUBLIC_URL must be an HTTP(S) origin without credentials, path, query or fragment.");
  return null;
}

function actorSigningSecret(environment: Environment, report: ConfigurationReport): string | null {
  const value = requiredValue(environment, "SHIPBASH_ACTOR_SIGNING_SECRET", report);
  if (value === null || Buffer.byteLength(value, "utf8") >= 32) return value;
  report.invalid.push("SHIPBASH_ACTOR_SIGNING_SECRET must contain at least 32 bytes.");
  return null;
}

function signInKeyring(environment: Environment, report: ConfigurationReport): SignInKeyring | null {
  const keyring = parsed(report, () => signInKeyringFromEnvironment(environment));
  if (keyring === null && !environment[SIGN_IN_ENCRYPTION_KEYS_VARIABLE]?.trim()) {
    report.missing.push(SIGN_IN_ENCRYPTION_KEYS_VARIABLE);
  }
  return keyring;
}

function localSignInProviders(environment: Environment, report: ConfigurationReport): LocalOAuthProvider[] {
  const providers = parsed(report, () => configuredLocalOAuthProviders(environment));
  if (providers?.length === 0) {
    report.invalid.push(
      "Local sign-in needs an OAuth client: SHIPBASH_GITHUB_OAUTH_CLIENT_ID with SHIPBASH_GITHUB_OAUTH_CLIENT_SECRET, "
        + "or SHIPBASH_GOOGLE_OAUTH_CLIENT_ID with SHIPBASH_GOOGLE_OAUTH_CLIENT_SECRET.",
    );
  }
  return providers ?? [];
}

/** A switch that is off unless set to "true". */
function switchedOn(environment: Environment, name: string, report: ConfigurationReport): boolean {
  const value = optionalValue(environment, name);
  if (value === null || value === "false") return false;
  if (value === "true") return true;
  report.invalid.push(`${name} must be true or false.`);
  return false;
}

/** Reads the whole configuration, or throws one ConfigurationError naming every problem. */
export function readConfiguration(
  environment: Environment,
  runtime: Runtime = configurationRuntime(environment),
): Configuration {
  const agents = readAgentServices(environment);
  const report: ConfigurationReport = { missing: [...agents.missing], invalid: [...agents.invalid] };
  const origin = publicUrl(environment, report);
  const secret = actorSigningSecret(environment, report);
  const keyring = signInKeyring(environment, report);
  const signInProviders = runtime === "local" ? localSignInProviders(environment, report) : [];
  const waitlist = switchedOn(environment, "SHIPBASH_WAITLIST", report);
  const runQuota = switchedOn(environment, "SHIPBASH_RUN_QUOTA", report);
  const integrations = readIntegrations(environment, origin, report);
  const hosted = runtime === "hosted" ? readHosted(environment, report) : null;
  if (hasProblems(report) || origin === null || secret === null || keyring === null) {
    throw new ConfigurationError(report);
  }
  return {
    runtime,
    agents: agents.services,
    publicUrl: origin,
    actorSigningSecret: secret,
    signInKeyring: keyring,
    signInProviders,
    waitlist,
    runQuota,
    integrations,
    hosted,
  };
}

let current: Configuration | undefined;

/** This process's configuration, read from its environment on first use. */
export function configuration(): Configuration {
  current ??= readConfiguration(process.env);
  return current;
}

/** A configuration read on Vercel, which always carries the hosted part. */
export type HostedRuntimeConfiguration = Configuration & { hosted: HostedConfiguration };

export function isHostedConfiguration(read: Configuration): read is HostedRuntimeConfiguration {
  return read.hosted !== null;
}

/** The configuration of a process running on Vercel, which is the only place the hosted runtime runs. */
export function hostedConfiguration(): HostedRuntimeConfiguration {
  const read = configuration();
  if (!isHostedConfiguration(read)) throw new Error("The hosted runtime is only available on Vercel.");
  return read;
}
