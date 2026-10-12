/**
 * Keys of the queries that are not API contract reads: files fetched by URL.
 * A contract read takes its key from its name in `apiReads` (`readKey`)
 * instead.
 *
 * Every argument is required. A filter matches a key by prefix, element by
 * element, and an `undefined` it carries is an element too: TanStack's
 * `partialMatchKey` compares it, so `[root, a, undefined]` never matches
 * `[root, a, b]`. A factory with an optional trailing argument would turn every
 * filter that leaves it out into one that matches only the keys built without
 * it, never the ones with it.
 */
export const queryKeys = {
  evidenceConsole: (url: string | null) => ["evidence-console", url] as const,
  evidenceConsoleLines: (url: string | null) => ["evidence-console-lines", url] as const,
};
