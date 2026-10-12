import { createRedactor } from "@shipbash/contracts/runtime/runner-redaction.mjs";

export const REDACTED = "[REDACTED]";
export const SENSITIVE_KEY_PATTERN =
  /(?:password|passwd|passphrase|secret|token|authorization|cookie|credential|api[-_]?key|auth[-_]?state)/iu;

// The host Activity runtime's configuration of the shared runner redactor
// (packages/contracts/src/runtime/runner-redaction.mjs): equals-separator
// key-values including a bare `token`, and 50-entry collection caps. Per-call
// sensitive values ride the extra parameter so the wrappers keep their exact
// signatures.
const hostRedactor = createRedactor({
  sensitiveKeyPattern: SENSITIVE_KEY_PATTERN,
  keyValuePattern:
    /\b(password|passwd|passphrase|secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_ ]?key|credential)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
  keyValueReplacement: `$1=${REDACTED}`,
  collectionEntryCap: 50,
});

export function redactString(
  value: string,
  sensitiveValues: readonly string[] = [],
  maximumLength = 4_000,
): string {
  return hostRedactor.redactString(value, maximumLength, sensitiveValues);
}

export function redactActivityRuntimeValue(
  value: unknown,
  key = "",
  sensitiveValues: readonly string[] = [],
): unknown {
  return hostRedactor.redactValue(value, key, sensitiveValues);
}

export function redactSensitiveValues(value: unknown, sensitiveValues: readonly string[]): unknown {
  return hostRedactor.redactSensitiveRuntimeValues(value, sensitiveValues);
}
