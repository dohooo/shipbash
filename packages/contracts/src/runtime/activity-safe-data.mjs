/**
 * How much of a string an Activity event's safeData field may carry.
 *
 * safeData is deliberately primitives-only: it crosses the container boundary
 * as NDJSON, is redacted at every hop, and a nested object would be an
 * unbounded, unreviewable payload. That rule silently ate the two fields
 * Discovery needs most — a knowledge entry's body and a question's options
 * were dropped between the agent and the host, so every recorded entry landed
 * as a rejection warning and no question ever reached the console with its
 * choices.
 *
 * A field whose name ends in `Json` is the escape hatch: exactly one JSON
 * document, serialized by the emitter, still a primitive, still redacted,
 * still bounded. The bound lives here because four hops apply it — the runner,
 * the host parser, the API view, and the browser client — and they must not
 * disagree about where a payload gets cut.
 */

/** Fields whose length limit is not the default, longest first. */
const FIELD_LIMITS = Object.freeze({
  screenshotDataUrl: 48_000,
  faviconDataUrl: 24_000,
});

export const STRUCTURED_FIELD_SUFFIX = "Json";
export const STRUCTURED_FIELD_LIMIT = 8_000;
export const DEFAULT_FIELD_LIMIT = 500;

export function safeDataFieldLimit(key) {
  const named = FIELD_LIMITS[key];
  if (named !== undefined) return named;
  return key.endsWith(STRUCTURED_FIELD_SUFFIX) ? STRUCTURED_FIELD_LIMIT : DEFAULT_FIELD_LIMIT;
}

/**
 * The shared skeleton of the safeData gate at the two hops that shape an
 * event for readers — the API view and the browser client: at most 20
 * entries, keys censored by the caller's sensitive pattern and truncated to
 * 100 characters, finite numbers and booleans and null verbatim, strings
 * transformed by the caller (redaction and bounding differ per hop, so they
 * arrive as a parameter rather than pretending to be one rule).
 *
 * The two inner hops deliberately do NOT share this skeleton: the container
 * emitter additionally enforces key-name shape and keeps non-finite numbers
 * (packages/runner/src/runtime/activity-runner/state.mjs `safeData`), and the host parser THROWS on
 * oversized records and non-primitive values instead of slicing
 * (src/activity-runtime.ts).
 */
export function boundedSafeData(value, { sensitiveKeyPattern, transformString }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const safe = {};
  for (const [key, entry] of Object.entries(value).slice(0, 20)) {
    if (!key || sensitiveKeyPattern.test(key)) continue;
    if (typeof entry === "string") safe[key.slice(0, 100)] = transformString(entry, key);
    else if (typeof entry === "number" && Number.isFinite(entry)) safe[key.slice(0, 100)] = entry;
    else if (typeof entry === "boolean" || entry === null) safe[key.slice(0, 100)] = entry;
  }
  return safe;
}

/**
 * Reads a structured field back. A truncated or redacted payload no longer
 * parses, and returning null there is the honest answer: the caller reports a
 * rejected entry rather than storing half a record.
 */
export function parseStructuredField(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The array twin of parseStructuredField, for fields like a question's options. */
export function parseStructuredList(value) {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
