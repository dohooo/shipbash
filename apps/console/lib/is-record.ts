/**
 * A parsed JSON value whose fields can be read one guard at a time.
 *
 * The contracts package exports the same predicate, but its module reaches
 * `node:crypto` through the production prompts, which cannot follow these call
 * sites into the browser bundle.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
