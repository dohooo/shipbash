/**
 * One field of a value nothing has vouched for yet, with the exact reach of
 * the optional chain it replaces: a null or undefined source answers
 * `undefined`, and `Object` boxes everything else, so a primitive, a function
 * and an object are all read the way `source?.[key]` read them. The twin in
 * apps/console/lib/property-of.ts serves that app's own copy of the reader
 * below; control-plane keeps its own so this module stays a leaf the
 * "use workflow" bundler can follow.
 */
function propertyOf(source: unknown, key: string): unknown {
  return source === null || source === undefined ? undefined : Reflect.get(Object(source), key);
}

/**
 * The HTTP status the Vercel Sandbox API reports on a rejection, or null when
 * the rejection is not one of its API errors. Only an integer status counts:
 * every call site compares the answer against a specific code, and a null
 * answer means "rethrow, this is not a status we know how to swallow".
 */
export function sandboxHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("response" in error)) return null;
  const status = propertyOf(error.response, "status");
  return Number.isInteger(status) ? Number(status) : null;
}
