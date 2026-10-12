"use client";

import { Globe, Link2, Mail, ShieldCheck, Smartphone, type LucideIcon } from "lucide-react";

import type { TeamSignInMethod } from "../../lib/web-client";

/**
 * What a way into the tested product is called, what it looks like, and which
 * of the three shapes of sign-in it belongs to. Two surfaces read this — the
 * Team's credential page and the Project's sign-in setup step — so it is stated
 * once rather than copied into each.
 */
export const METHOD_NAMES: Record<TeamSignInMethod, string> = {
  google: "Google",
  github: "GitHub",
  apple: "Apple",
  sso: "SSO",
  phone_code: "Phone + code",
  magic_link: "Magic link",
  any_login_page: "Any login page",
  email_password: "Account + password",
};

/**
 * The option as the picker offers it. A third-party button is one the reader
 * presses on the product's own login page, so it is worded the way that page
 * words it; everything else is a way in they are adding to ShipBash.
 */
export const METHOD_OPTIONS: Record<TeamSignInMethod, string> = {
  google: "Continue with Google",
  github: "Continue with GitHub",
  apple: "Continue with Apple",
  email_password: "Add Account + password",
  phone_code: "Add Phone + code",
  magic_link: "Add Magic link",
  sso: "Add SSO",
  any_login_page: "Add Any login page",
};

interface MethodGroup {
  title: string;
  methods: readonly TeamSignInMethod[];
}

/** Available sign-ins come first; upcoming methods stay together below them. */
export const METHOD_GROUPS: readonly MethodGroup[] = [
  { title: "", methods: ["github", "email_password", "any_login_page"] },
  { title: "Coming soon", methods: ["google", "apple", "phone_code", "magic_link", "sso"] },
];

/**
 * The one method ShipBash signs in with itself, which is why it takes a form
 * rather than a browser — and why it is the one method the takeover lane
 * cannot finish. Kept as a literal so that exclusion is expressible.
 */
export const PASSWORD_METHOD = "email_password" satisfies TeamSignInMethod;

/** lobehub's own marks, served the way `.connection-mark` serves a Slack workspace's. */
export const BRAND_MARKS: Partial<Record<TeamSignInMethod, string>> = {
  google: "/google-color.svg",
  github: "/github.svg",
  apple: "/apple.svg",
};

/** Real lucide glyphs for the lanes no brand stands behind. */
const GENERIC_MARKS: Record<string, LucideIcon> = {
  email_password: Mail,
  sso: ShieldCheck,
  phone_code: Smartphone,
  magic_link: Link2,
  any_login_page: Globe,
};

/** The glyph alone, for the option bars and the saved bars that are not cards. */
export function SignInGlyph({ method }: { method: TeamSignInMethod }) {
  const brand = BRAND_MARKS[method];
  // biome-ignore lint/performance/noImgElement: a decorative local brand mark sized by its container; next/image would not optimize an SVG.
  if (brand) return <img alt="" src={brand} />;
  const Icon = GENERIC_MARKS[method] ?? Globe;
  return <Icon aria-hidden="true" />;
}

export function SignInMark({ method }: { method: TeamSignInMethod }) {
  const generic = !BRAND_MARKS[method];
  return (
    <span className="auth-mark" data-generic={generic ? "" : undefined} aria-hidden="true">
      <SignInGlyph method={method} />
    </span>
  );
}
