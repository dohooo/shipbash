/**
 * Pure helpers for the Activity progress reader: the structured-result sniff
 * and the labels it publishes agent narratives under.
 */

/**
 * True when text is the agent's structured result JSON rather than prose.
 * Detection is prefix-based on purpose: bodies are routinely truncated by
 * redaction limits, and a truncated result no longer parses as JSON, so a
 * JSON.parse-based check would wave the leak straight through.
 */
export function structuredResultLikeText(text) {
  if (typeof text !== "string") return false;
  const head = text.trimStart().slice(0, 400);
  if (!head.startsWith("{")) return false;
  return /"status"\s*:/.test(head)
    && (/"authState"\s*:/.test(head) || /"publicMarkdown"\s*:/.test(head) || /"summary"\s*:/.test(head));
}

export const NARRATIVE_LABELS = Object.freeze({
  observation: "Observation",
  finding: "Finding",
  hypothesis: "Hypothesis",
  plan: "Plan",
});
