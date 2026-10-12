import "server-only";

import { cacheLife } from "next/cache";

import { isRecord } from "../is-record";
import type { PublicSupabaseConfig } from "./config";

/** The ways in the sign-in page knows how to offer. */
const SIGN_IN_PROVIDERS = ["github", "google"] as const;

export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

/**
 * The ways in Supabase Auth has enabled, as its settings endpoint reports
 * them (GoTrue `GET /auth/v1/settings`): locally the dev stack enables each
 * one whose OAuth client it was given, and a hosted deployment enables its
 * own in Supabase, so the page never offers one that would only answer with
 * an error. Read once every few minutes rather than on every visit.
 */
export async function enabledSignInProviders(config: PublicSupabaseConfig): Promise<SignInProvider[]> {
  "use cache";
  cacheLife("minutes");
  const response = await fetch(new URL("/auth/v1/settings", config.url), {
    headers: { apikey: config.publishableKey },
  });
  if (!response.ok) throw new Error(`Supabase Auth settings answered ${String(response.status)}.`);
  const settings: unknown = await response.json();
  const external = isRecord(settings) && isRecord(settings.external) ? settings.external : {};
  return SIGN_IN_PROVIDERS.filter((provider) => external[provider] === true);
}
