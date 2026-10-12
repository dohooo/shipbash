// The Activity runner's redaction boundary: one shared redactor instance
// plus the redacted stderr pipe built on it. Everything a child process or
// event says passes through here before it can leave the container.
import { createRedactor } from "@shipbash/contracts/runtime/runner-redaction.mjs";

import { SENSITIVE_KEY_PATTERN, STDERR_TAIL_BYTES } from "./environment.mjs";

/**
 * The Activity configuration of the shared redactor: a bare `token` in the
 * key-value keyword list, 50-entry collection caps, and a 500-character
 * safeError — deliberate divergences from the suite runner.
 */
export const redactor = createRedactor({
  sensitiveKeyPattern: SENSITIVE_KEY_PATTERN,
  keyValuePattern:
    /\b(password|passwd|passphrase|secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_ ]?key|credential)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
  collectionEntryCap: 50,
  safeErrorLimit: 500,
});
export const { registerSecret, registerCredentialValues, registerTrustedAccess } = redactor;
export const redactString = redactor.redactString;
export const redactActivityValue = redactor.redactValue;
export const redactSensitiveRuntimeValues = redactor.redactSensitiveRuntimeValues;
export const safeError = redactor.safeError;

/**
 * Streams the child's stderr to ours, redacted, while keeping a bounded
 * redacted tail. A failing child's last words are the only thing that can
 * explain it after the fact, and the runner's own stderr is not readable
 * from a finished Activity.
 */
export function pipeRedactedStderr(stderr, tail = null) {
  let buffer = "";
  stderr.setEncoding("utf8");
  const keep = (line) => {
    if (!tail) return;
    tail.text = `${tail.text}${line}\n`.slice(-STDERR_TAIL_BYTES);
  };
  stderr.on("data", (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const redacted = redactString(line);
      process.stderr.write(`${redacted}\n`);
      keep(redacted);
    }
  });
  stderr.on("end", () => {
    if (!buffer) return;
    const redacted = redactString(buffer);
    process.stderr.write(`${redacted}\n`);
    keep(redacted);
  });
}
