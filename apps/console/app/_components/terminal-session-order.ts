/**
 * The order a finished run's retained sessions sit in.
 *
 * The logs are fetched concurrently, so the order they land in is the
 * network's. Appending each one as it arrives made the panel's "newest
 * session" whichever fetch happened to finish last — a different shell on a
 * slow morning than on a fast one. Two keys settle it, both facts about the
 * run rather than the fetch: the position the recording's terminal track gives
 * the session, and failing that (a walk whose recording was not kept, a share,
 * which carries no track, or a shell past the track's bound) the epoch in the
 * log's own header.
 */
export interface RetainedSessionKey {
  /** The recording's terminal track position, or null when it named none. */
  order: number | null;
  /** The epoch the shell opened at, from the session log's header. */
  startedAt: number;
}

const UNORDERED = Number.MAX_SAFE_INTEGER;

function compare(left: RetainedSessionKey | undefined, right: RetainedSessionKey | undefined): number {
  return (left?.order ?? UNORDERED) - (right?.order ?? UNORDERED)
    || (left?.startedAt ?? 0) - (right?.startedAt ?? 0);
}

/**
 * Adds one hydrated session in its own place. `keys` accumulates across calls
 * because sorting needs the key of every session already in the list, not just
 * the arriving one; the id breaks a tie so the result never depends on which
 * fetch returned first.
 */
export function insertRetainedSession<T extends { id: string }>(
  sessions: readonly T[],
  session: T,
  keys: Map<string, RetainedSessionKey>,
  key: RetainedSessionKey,
): readonly T[] {
  if (sessions.some((existing) => existing.id === session.id)) return sessions;
  keys.set(session.id, key);
  return [...sessions, session].sort((left, right) => (
    compare(keys.get(left.id), keys.get(right.id)) || left.id.localeCompare(right.id)
  ));
}
