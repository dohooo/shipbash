import "server-only";

import { configuration } from "@shipbash/control-plane/configuration";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { sanitizeSupabaseCookieWrites, supabaseCookieSecurity } from "./cookies";
import { publicSupabaseConfig } from "./config";

async function createServerSupabaseClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const config = publicSupabaseConfig();
  const security = supabaseCookieSecurity(configuration().publicUrl);
  return createServerClient(config.url, config.publishableKey, {
    cookieOptions: security.cookieOptions,
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of sanitizeSupabaseCookieWrites(
            cookiesToSet,
            security.secure,
          )) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot write cookies. A proxy refreshes them instead.
        }
      },
    },
  });
}

type UserVerifyingClient = Pick<SupabaseClient, "auth">;

export async function getVerifiedUser(
  client?: UserVerifyingClient,
): Promise<User | null> {
  const supabase = client ?? await createServerSupabaseClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

class AuthenticationRequiredError extends Error {
  constructor() {
    super("Authentication is required.");
    this.name = "AuthenticationRequiredError";
  }
}

export async function requireVerifiedUser(
  client?: UserVerifyingClient,
): Promise<User> {
  const user = await getVerifiedUser(client);
  if (!user) throw new AuthenticationRequiredError();
  return user;
}
