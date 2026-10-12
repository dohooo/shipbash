/** Which check a sign-in leg runs: a saved session in a fresh browser, or a saved password typed in. */
export type SignInLegMode = "sign-in-verify" | "sign-in-login";

/** What a leg said about the way in it checked. */
export interface SignInVerifyOutcome {
  verified: boolean;
  label: string | null;
  reason: string | null;
}

export function signInLegEnvironment(leg: { mode: SignInLegMode; projectHash: string }): Record<string, string>;

export function signInVerifyOutcomeFrom(logText: string): SignInVerifyOutcome | null;
