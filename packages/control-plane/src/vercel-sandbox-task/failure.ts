/**
 * The single place a failure becomes text a sandboxed task may emit. URLs and
 * bearer tokens are redacted before anything reaches stderr or a Run event,
 * and the result is bounded.
 */
export function sanitizedFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s]+/giu, "[REDACTED_URL]")
    .replace(/\bBearer\s+[^\s]+/giu, "Bearer [REDACTED]")
    .slice(0, 2_000) || "Sandbox task failed.";
}
