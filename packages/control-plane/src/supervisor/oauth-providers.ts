import { shipbashEnvironmentValue } from "../environment.ts";

/** The ways to sign in local Supabase Auth can offer, each switched on by its own pair of variables. */
export const LOCAL_OAUTH_PROVIDERS = ["github", "google"] as const;

export type LocalOAuthProvider = (typeof LOCAL_OAUTH_PROVIDERS)[number];

/** The providers this environment configures. Half a pair is a mistake, not an absence. */
export function configuredLocalOAuthProviders(environment: NodeJS.ProcessEnv): LocalOAuthProvider[] {
  return LOCAL_OAUTH_PROVIDERS.filter((provider) => {
    const prefix = `${provider.toUpperCase()}_OAUTH_CLIENT`;
    const clientId = shipbashEnvironmentValue(environment, `${prefix}_ID`)?.trim();
    const clientSecret = shipbashEnvironmentValue(environment, `${prefix}_SECRET`)?.trim();
    if (!clientId && !clientSecret) return false;
    if (!clientId || !clientSecret) {
      throw new Error(`SHIPBASH_${prefix}_ID and SHIPBASH_${prefix}_SECRET must be configured together.`);
    }
    return true;
  });
}

/** The config.toml sections for those providers; secret values stay in the process environment. */
export function localOAuthProviderConfig(environment: NodeJS.ProcessEnv): string {
  return configuredLocalOAuthProviders(environment).map((provider) => {
    const prefix = `SHIPBASH_${provider.toUpperCase()}_OAUTH_CLIENT`;
    return [
      "",
      `# Runtime-only local ${provider} identity provider. Secret values are resolved from the process environment.`,
      `[auth.external.${provider}]`,
      "enabled = true",
      `client_id = "env(${prefix}_ID)"`,
      `secret = "env(${prefix}_SECRET)"`,
      "skip_nonce_check = false",
      "",
    ].join("\n");
  }).join("");
}
