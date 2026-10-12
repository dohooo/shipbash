/**
 * One field of a value nothing has vouched for yet.
 *
 * Reading `value.field` off an `unknown` needs either a cast or a guard for
 * every field; this reads the one field and hands back another `unknown`, so a
 * caller narrows what it actually uses and nothing else. A `null` or
 * `undefined` source answers `undefined` rather than throwing, which is what
 * an optional chain did before.
 */
export function propertyOf(source: unknown, key: string): unknown {
  return source === null || source === undefined ? undefined : Reflect.get(Object(source), key);
}
