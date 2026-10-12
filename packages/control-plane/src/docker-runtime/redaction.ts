import { createRedactor } from "@shipbash/contracts/runtime/runner-redaction.mjs";

export const REDACTED = "[REDACTED]";
export const SENSITIVE_KEY_PATTERN =
  /(?:password|passwd|passphrase|secret|token|authorization|cookie|credential|api[-_]?key|auth[-_]?state)/i;

// The host Docker runtime's configuration of the shared runner redactor
// (packages/contracts/src/runtime/runner-redaction.mjs): NO final key-value
// rule, and truncation with an ellipsis before redacting instead of a slice
// after.
const hostRedactor = createRedactor({
  sensitiveKeyPattern: SENSITIVE_KEY_PATTERN,
  keyValuePattern: null,
  truncation: "ellipsis-before-redact",
});

export function redactString(value: string, sensitiveValues: readonly string[] = []): string {
  return hostRedactor.redactString(value, 4_000, sensitiveValues);
}

export function redactRuntimeStderr(
  value: string,
  encryptionKey?: string,
  sensitiveValues: readonly string[] = [],
): string {
  const redacted = redactString(value, sensitiveValues);
  return encryptionKey ? redacted.replaceAll(encryptionKey, REDACTED) : redacted;
}

export function redactRuntimeValue(
  value: unknown,
  key = "",
  sensitiveValues: readonly string[] = [],
): unknown {
  return hostRedactor.redactValue(value, key, sensitiveValues);
}
