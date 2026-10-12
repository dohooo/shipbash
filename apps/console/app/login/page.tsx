import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { safeSameSitePath } from "@shipbash/contracts/same-site-path";
import { type PublicSupabaseConfig, publicSupabaseConfig } from "../../lib/supabase/config";
import { getVerifiedUser } from "../../lib/supabase/server";
import { type SignInProvider, enabledSignInProviders } from "../../lib/supabase/sign-in-providers";
import { AuthPageLoading } from "../_components/auth-page-loading";
import { route } from "../_lib/route";
import { LoginExperience } from "./login-experience";

export const metadata: Metadata = { title: "Sign in" };

interface LoginPageProps {
  searchParams: Promise<{
    next?: string | string[];
    error?: string | string[];
    provider?: string | string[];
  }>;
}

/** Named after the way in the attempt used; an error that names none was GitHub's. */
function errorMessage(code: string, provider: string | undefined): string | undefined {
  const name = provider === "google" ? "Google" : "GitHub";
  const messages: Record<string, string> = {
    account: "Your account could not be set up. Please try again.",
    callback: `${name} sign-in could not be completed. Please try again.`,
    configuration: `${name} sign-in is not configured for this ShipBash instance.`,
    oauth: `${name} did not complete the sign-in request. Please try again.`,
    // An expired session is routine, not an error: landing on the sign-in page
    // already says everything, so `error=session` renders no message.
  };
  return messages[code];
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

/** `/<team>/<product>/verifications/<id>` — the address a Slack alert links to. */
const RUN_PATH_PATTERN = /^\/[^/]+\/[^/]+\/verifications\/[^/?#]+(?:[?#]|$)/u;

/**
 * Who is arriving. Someone following an evidence link may never have seen
 * ShipBash, and greeting them as a returning reader is the one thing this
 * screen must not do — so the run link gets the headline for the run it is
 * about, and a sentence saying what the product is.
 */
function loginIntro(next: string): { title: string; description: string } {
  return RUN_PATH_PATTERN.test(next)
    ? {
        title: "Sign in to open this run.",
        description: "ShipBash walks your team's real user journeys and records what breaks.",
      }
    : {
        title: "Welcome back.",
        description: "Browser and terminal tests. Recorded proof. Confidence in every release.",
      };
}

/** The ways in Supabase Auth offers; null when it cannot say right now, which is not cached, so the next visit asks again. */
async function signInProviders(auth: PublicSupabaseConfig): Promise<SignInProvider[] | null> {
  try {
    return await enabledSignInProviders(auth);
  } catch (error) {
    console.error("[login] Supabase Auth's settings could not be read:", error);
    return null;
  }
}

function authConfiguration(): PublicSupabaseConfig | null {
  try {
    return publicSupabaseConfig();
  } catch {
    return null;
  }
}

export async function LoginContent({ searchParams }: LoginPageProps) {
  // Reading the visitor's session is request-time work: getVerifiedUser goes
  // through Supabase auth, which checks token expiry with Date.now(), a value
  // the prerender cannot stand in for. connection() marks this render dynamic
  // first, the way every other request-time read here does, so the Suspense
  // fallback covers the prerender instead of the clock tripping it.
  await connection();
  const query = await searchParams;
  const next = safeSameSitePath(firstValue(query.next));
  const auth = authConfiguration();
  const user = auth ? await getVerifiedUser() : null;
  if (user) redirect(route(next));
  const providers = auth ? await signInProviders(auth) : [];

  const error = firstValue(query.error);
  const message = error ? errorMessage(error, firstValue(query.provider)) : undefined;

  return (
    <LoginExperience
      providers={providers}
      errorMessage={message}
      loginHref={`/auth/login?next=${encodeURIComponent(next)}`}
      {...loginIntro(next)}
    />
  );
}

export default function LoginPage(props: LoginPageProps) {
  return (
    <Suspense fallback={<AuthPageLoading label="Loading sign in" />}>
      <LoginContent {...props} />
    </Suspense>
  );
}
