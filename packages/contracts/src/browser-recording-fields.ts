/**
 * The field readers the recording playback document and its tracks share.
 * Each returns null for a value it cannot use, and the parsers turn a null
 * into an unusable section.
 */

/** A one-line text of at most `maximum` characters, trimmed. */
export function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const normalized = value.trim();
  return normalized.length <= maximum && !/[\r\n]/u.test(normalized) ? normalized : null;
}

/** A safe integer above zero and at most `maximum`. */
export function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum
    ? Number(value)
    : null;
}

/** A safe integer of zero or more. */
export function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

/**
 * One of the document's tracks: a list every document carries, even empty,
 * of at most `bound` entries, each read against the entry before it. A
 * missing track, too many entries, or any unusable one makes it null.
 */
export function requiredTrack<T>(
  value: unknown,
  bound: number,
  parseItem: (candidate: unknown, previous: T | undefined) => T | null,
): T[] | null {
  if (!Array.isArray(value) || value.length > bound) return null;
  const parsed: T[] = [];
  for (const candidate of value) {
    const entry = parseItem(candidate, parsed.at(-1));
    if (entry === null) return null;
    parsed.push(entry);
  }
  return parsed;
}
