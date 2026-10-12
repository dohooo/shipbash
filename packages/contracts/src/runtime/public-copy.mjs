/**
 * The boundary between the two languages ShipBash speaks.
 *
 * Users read product-language sentences about their product; operators read
 * structured diagnostics about ours. A sentence that names our plumbing — a
 * container path, a CLI, an errno, an exit code — has crossed that boundary,
 * and would otherwise reach a report verbatim. This
 * module is the single definition of what counts as internal and the one
 * chokepoint that keeps it out of public copy. Both the container runtime
 * and the host import it; never fork a copy of the pattern.
 */

export const INTERNAL_TOKEN_PATTERN =
  /ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT|EPIPE|(?<![\w.-])\/shipbash\/|agent-browser|exited with code|errno|node:internal/iu;

export const HARNESS_FAULT_FALLBACK =
  "ShipBash hit an internal fault while walking this journey. This is a ShipBash-side fault, not a finding about your product.";

export const CHECKPOINT_FAULT_FALLBACK =
  "ShipBash hit an internal fault before this checkpoint could be judged.";

/**
 * Returns the sentence unchanged when it is public, the fallback otherwise.
 * Never edits text: a sentence that mentions internals was written for the
 * wrong audience, and partial redaction leaves a mangled non-sentence. The
 * original wording is evidence about our own defect — callers keep it in
 * their diagnostics, not in the reader's report.
 */
export function sanitizePublicSentence(value, fallback = HARNESS_FAULT_FALLBACK) {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  return INTERNAL_TOKEN_PATTERN.test(value) ? fallback : value;
}
