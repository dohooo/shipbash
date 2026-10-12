/**
 * The value validators every runtime contract shares — an object, a closed
 * key set, a bounded string, an identifier, a positive integer, an http(s)
 * URL — so the host and the container state one rule in one sentence.
 * A leaf with no imports, so a workflow bundle can reach it.
 */
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rejectUnknownKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${field}.${key} is not supported.`);
  }
}

export function requiredString(value, field, maximumLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    throw new Error(`${field} must be at most ${maximumLength} characters.`);
  }
  return normalized;
}

export function optionalString(value, field, maximumLength) {
  if (value === null || value === undefined) return null;
  return requiredString(value, field, maximumLength);
}

export function identifier(value, field) {
  const normalized = requiredString(value, field, 128);
  if (!IDENTIFIER_PATTERN.test(normalized)) throw new Error(`${field} contains unsafe characters.`);
  return normalized;
}

export function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

export function httpUrl(value, field) {
  let parsed;
  try {
    parsed = new URL(requiredString(value, field, 2_048));
  } catch {
    throw new Error(`${field} must be a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} must use http or https.`);
  }
  if (parsed.username || parsed.password) throw new Error(`${field} must not contain credentials.`);
  return parsed.toString();
}
