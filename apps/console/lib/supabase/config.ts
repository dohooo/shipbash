import { isRecord } from "../is-record";

export interface PublicSupabaseConfig {
  url: string;
  publishableKey: string;
}

function jwtRole(value: string): string | undefined {
  const parts = value.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const normalized = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload: unknown = JSON.parse(atob(padded));
    if (!isRecord(payload)) return undefined;
    const role = payload.role;
    return typeof role === "string" ? role : undefined;
  } catch {
    return undefined;
  }
}

export function publicSupabaseConfig(): PublicSupabaseConfig {
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!rawUrl || !publishableKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and a Supabase publishable key must be configured.",
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must use HTTP or HTTPS.");
  }
  if (jwtRole(publishableKey) === "service_role" || publishableKey.startsWith("sb_secret_")) {
    throw new Error("A Supabase service-role or secret key must never be exposed to the Web app.");
  }
  return { url: url.origin, publishableKey };
}
