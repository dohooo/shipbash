// The suite runner's redaction boundary: one shared redactor instance plus
// the redacted stderr/log sinks built on it. Everything a child process or
// event says passes through here before it can leave the container.
import { createRedactor } from "@shipbash/contracts/runtime/runner-redaction.mjs";

import { AUTH_STATES, SENSITIVE_KEY_PATTERN, STDERR_TAIL_BYTES } from "./environment.mjs";

/**
 * The suite configuration of the shared redactor: authState passthrough, no
 * collection caps, and the key-value keyword list without a bare `token` —
 * deliberate divergences from the Activity runner.
 */
export const redactor = createRedactor({
  sensitiveKeyPattern: SENSITIVE_KEY_PATTERN,
  keyValuePattern:
    /\b(password|passwd|passphrase|secret|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_ ]?key|credential)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
  authStates: AUTH_STATES,
  safeErrorLimit: 1_000,
});
export const { registerSecret, registerCredentialValues, registerTrustedAccess } = redactor;
export const redactEventValue = redactor.redactValue;
export const redactLogLine = redactor.redactLogLine;
export const redactString = redactor.redactString;
export const createRedactedLineSink = redactor.createRedactedLineSink;
export const redactSensitiveRuntimeValues = redactor.redactSensitiveRuntimeValues;
export const safeError = redactor.safeError;

/**
 * Streams the child's stderr to ours, redacted, while keeping a bounded tail.
 * A failing child's last words are the only thing that can explain it after
 * the fact, and the runner's own stderr is unreadable from a finished Run.
 */
export function pipeRedactedStderr(stderr, tail = null) {
  const sink = createRedactedLineSink((line) => {
    process.stderr.write(line);
    if (tail) tail.text = `${tail.text}${line}`.slice(-STDERR_TAIL_BYTES);
  });
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk) => sink.push(chunk));
  stderr.on("end", () => sink.finish());
  return sink;
}

export function rawLog(message) {
  const sink = createRedactedLineSink((line) => process.stderr.write(line));
  sink.push(message);
  sink.finish();
}
