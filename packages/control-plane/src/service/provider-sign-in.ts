/**
 * Where a third-party sign-in happens, and where it is checked.
 *
 * Pre-authorising Google, GitHub or Apple means signing in to the provider
 * itself: the takeover browser opens the provider's own sign-in page, the
 * person signs in there, and the session ShipBash keeps is the provider's.
 * The product still gets its "Sign in with Google" click later, from the
 * agent, and that click is one hop because the provider already knows the
 * browser. So the check is against the provider too: with the captured
 * session, the provider's own account page must open signed in.
 *
 * Every other method is the product's own door, so it opens and checks
 * against the product and this module answers null for it.
 */
import type { TeamSignInMethod } from "@shipbash/contracts/database-contract-types";

interface ProviderSignIn {
  /** The page the person signs in on. */
  signInUrl: string;
  /** A page only a signed-in account reaches; signed out, the provider bounces it to sign-in. */
  checkUrl: string;
}

const PROVIDERS: Partial<Record<TeamSignInMethod, ProviderSignIn>> = {
  google: {
    signInUrl: "https://accounts.google.com/",
    checkUrl: "https://myaccount.google.com/",
  },
  github: {
    signInUrl: "https://github.com/login",
    checkUrl: "https://github.com/settings/profile",
  },
  apple: {
    signInUrl: "https://appleid.apple.com/sign-in",
    checkUrl: "https://appleid.apple.com/account/manage",
  },
};

/** The provider's sign-in page for a third-party method, or null for the product's own. */
export function providerSignInUrl(method: TeamSignInMethod | null | undefined): string | null {
  return method ? (PROVIDERS[method]?.signInUrl ?? null) : null;
}

/** The provider's signed-in-only page for a third-party method, or null for the product's own. */
export function providerCheckUrl(method: TeamSignInMethod | null | undefined): string | null {
  return method ? (PROVIDERS[method]?.checkUrl ?? null) : null;
}
