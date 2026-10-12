import type { CaseVerdict } from "@shipbash/contracts/database-contract-types";

/** "verification_incomplete" → "Verification incomplete". */
function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function statusLabel(value: string): string {
  // "auth" is runtime shorthand; readers see the same label as Status.
  if (value === "waiting_for_auth") return "Waiting for sign-in";
  return sentenceCase(value.replaceAll("_", " "));
}

export function statusTone(status: string, verdict: CaseVerdict | null = null): string {
  const value = verdict ?? status;
  if (value === "passed" || value === "running") return "positive";
  if (value === "failed" || value === "error") return "negative";
  if (value === "blocked" || value === "waiting_for_auth") return "warning";
  if (value === "canceled" || value === "canceling") return "muted";
  return "neutral";
}
