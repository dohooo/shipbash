/**
 * Dependency-free structural guard for plain object records.
 *
 * Kept as its own leaf module (no imports) so that workflow-bundled code — e.g.
 * apps/console/workflows/*, which transitively imports control-plane modules —
 * can narrow unknown values without dragging in `@shipbash/contracts`'s
 * activity-contracts, whose transitive `production-prompts` pulls in node:crypto
 * and is rejected by the "use workflow" bundler.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Wider than {@link isRecord}: arrays pass, and so does any other non-null
 * object. It is the guard for call sites that read properties off an untyped
 * value behind a bare `typeof value === "object"` test, where narrowing to a
 * plain record would start refusing shapes those call sites accept. Property
 * reads through it still walk the prototype chain.
 */
export function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
