import {
  createChunks,
  stringFromBase64URL,
  stringToBase64URL,
  type CookieOptions,
} from "@supabase/ssr";

import { isRecord } from "../is-record";

const BASE64_PREFIX = "base64-";

interface SupabaseCookieWrite {
  name: string;
  value: string;
  options: CookieOptions;
}

function chunkIdentity(name: string): { base: string; position: number | null } {
  const match = /^(.*)\.(0|[1-9][0-9]*)$/u.exec(name);
  return match?.[1]
    ? { base: match[1], position: Number(match[2]) }
    : { base: name, position: null };
}

function sessionWithoutProviderCredentials(value: string): string | null {
  let decoded: string;
  try {
    decoded = value.startsWith(BASE64_PREFIX)
      ? stringFromBase64URL(value.slice(BASE64_PREFIX.length))
      : value;
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.access_token !== "string" || typeof parsed.refresh_token !== "string") {
    return null;
  }
  const sanitized = { ...parsed };
  delete sanitized.provider_token;
  delete sanitized.provider_refresh_token;
  const serialized = JSON.stringify(sanitized);
  return value.startsWith(BASE64_PREFIX)
    ? `${BASE64_PREFIX}${stringToBase64URL(serialized)}`
    : serialized;
}

function secureSupabaseCookieOptions(
  options: CookieOptions,
  secure: boolean,
): CookieOptions {
  return {
    ...options,
    httpOnly: true,
    path: options.path ?? "/",
    sameSite: "lax",
    secure,
  };
}

/**
 * Supabase returns GitHub provider credentials once inside the OAuth session.
 * ShipBash consumes that value in the callback, but never persists it in the
 * browser's durable Supabase session cookie.
 */
export function sanitizeSupabaseCookieWrites(
  cookies: readonly SupabaseCookieWrite[],
  secure: boolean,
): SupabaseCookieWrite[] {
  const hardened = cookies.map((cookie) => ({
    ...cookie,
    options: secureSupabaseCookieOptions(cookie.options, secure),
  }));
  const groups = new Map<string, Array<{ index: number; position: number | null }>>();
  hardened.forEach((cookie, index) => {
    if (!cookie.value || cookie.options.maxAge === 0) return;
    const identity = chunkIdentity(cookie.name);
    const entries = groups.get(identity.base) ?? [];
    entries.push({ index, position: identity.position });
    groups.set(identity.base, entries);
  });

  const replacements = new Map<number, SupabaseCookieWrite[]>();
  const skipped = new Set<number>();
  for (const [base, entries] of groups) {
    const direct = entries.find((entry) => entry.position === null);
    const ordered = direct
      ? [direct]
      : [...entries].sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
    // biome-ignore lint/style/noNonNullAssertion: the index comes from the entries gathered above, so it is always in range.
    const combined = ordered.map((entry) => hardened[entry.index]!.value).join("");
    const sanitized = sessionWithoutProviderCredentials(combined);
    if (sanitized === null) continue;
    const first = Math.min(...entries.map((entry) => entry.index));
    // biome-ignore lint/style/noNonNullAssertion: the index comes from the entries gathered above, so it is always in range.
    const options = hardened[first]!.options;
    replacements.set(first, createChunks(base, sanitized).map((chunk) => ({
      name: chunk.name,
      value: chunk.value,
      options,
    })));
    for (const entry of entries) skipped.add(entry.index);
  }

  return hardened.flatMap((cookie, index) => {
    const replacement = replacements.get(index);
    if (replacement) return replacement;
    return skipped.has(index) ? [] : [cookie];
  });
}

export function supabaseCookieSecurity(publicOrigin: string | undefined): {
  cookieOptions: CookieOptions;
  secure: boolean;
} {
  const secure = publicOrigin ? new URL(publicOrigin).protocol === "https:" : false;
  return {
    secure,
    cookieOptions: secureSupabaseCookieOptions({}, secure),
  };
}
