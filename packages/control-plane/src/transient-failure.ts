/**
 * What counts as a passing infrastructure failure, the kind a queued task is
 * retried for. Kept apart from the queue so the Sandbox's executor can throw
 * and classify these without bundling pg-boss.
 */
export class TransientQueueTaskError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransientQueueTaskError";
  }
}

const TRANSIENT_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOENT",
  "ENOSPC",
  "ETIMEDOUT",
  "40001",
  "40P01",
  "55P03",
  "57P01",
  "57P02",
  "57P03",
]);

export function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code.toUpperCase() : null;
}

/** Explicit infrastructure taxonomy; ordinary Error messages are not retryable. */
export function isTransientInfrastructureFailure(error: unknown): boolean {
  if (error instanceof TransientQueueTaskError) return true;
  const code = errorCode(error);
  if (
    code &&
    (TRANSIENT_ERROR_CODES.has(code) || code.startsWith("08") || code.startsWith("53"))
  ) return true;
  if (error instanceof Error) {
    // The message may now carry Docker's own reason after a colon; the match
    // must not depend on the sentence ending where it used to, or a clearer
    // message would silently stop being retried.
    if (
      /Docker did not (?:finish writing|write|report) (?:(?:a valid|the) )?(?:runner |Activity )?(?:container id|loopback stream port|browser stream port)/u
        .test(error.message)
    ) return true;
    if (error.cause && error.cause !== error) return isTransientInfrastructureFailure(error.cause);
  }
  return false;
}
