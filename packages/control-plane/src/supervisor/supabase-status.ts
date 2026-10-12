import { isRecord } from "../is-record.ts";
import { LOCAL_OAUTH_PROVIDERS, type LocalOAuthProvider } from "./oauth-providers.ts";

export interface LocalSupabaseEnvironment {
  apiUrl: string;
  databaseUrl: string;
  serviceRoleKey: string;
  publishableKey: string;
}

function parsedRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function requiredStatusValue(
  status: Record<string, unknown>,
  key: keyof Pick<Record<string, unknown>, "API_URL" | "DB_URL" | "SERVICE_ROLE_KEY" | "ANON_KEY">,
): string {
  const value = status[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Local Supabase did not report ${key}.`);
  }
  return value;
}

export function parseSupabaseStatus(raw: string): LocalSupabaseEnvironment {
  const status = parsedRecord(raw);
  if (!status) throw new Error("Local Supabase returned an invalid status response.");
  return {
    apiUrl: requiredStatusValue(status, "API_URL"),
    databaseUrl: requiredStatusValue(status, "DB_URL"),
    serviceRoleKey: requiredStatusValue(status, "SERVICE_ROLE_KEY"),
    publishableKey: requiredStatusValue(status, "ANON_KEY"),
  };
}

/** Whether the running Auth offers a different set of providers than the config now asks for. */
export function localSupabaseAuthProviderRequiresRestart(
  expected: readonly LocalOAuthProvider[],
  rawSettings: string,
): boolean {
  const settings = parsedRecord(rawSettings);
  if (!settings) throw new Error("Local Supabase Auth returned invalid settings.");
  const external = settings.external;
  if (!isRecord(external)) {
    throw new Error("Local Supabase Auth did not report external providers.");
  }
  return LOCAL_OAUTH_PROVIDERS.some((provider) => {
    const enabled = external[provider];
    if (typeof enabled !== "boolean") {
      throw new Error(`Local Supabase Auth did not report the ${provider} provider.`);
    }
    return enabled !== expected.includes(provider);
  });
}

/**
 * `supabase start` refusing because one is already in flight.
 *
 * The CLI holds a per-project lock, so a second start while the first is still
 * bringing containers up exits non-zero with this pair of lines. It describes a
 * stack that is arriving, not one that failed — which is why it is waited out
 * rather than raised.
 */
export function localSupabaseStartAlreadyRunning(output: string): boolean {
  return /supabase start is already running/iu.test(output);
}
