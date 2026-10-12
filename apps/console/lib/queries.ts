import { type QueryKey, queryOptions, skipToken } from "@tanstack/react-query";

import type { ApiReads, BrowserReads } from "./api-reads";

/**
 * Everything about a read follows from its entry in `apiReads`: its key is its
 * name followed by its arguments, and its query options read it through
 * whichever transport the table was built over. Only what differs from the
 * console's defaults is written here.
 */
type Reads = ApiReads & BrowserReads;
export type ReadName = keyof Reads;
type ReadArgs = { [N in ReadName]: Parameters<Reads[N]> };
type ReadResults = { [N in ReadName]: Awaited<ReturnType<Reads[N]>> };
/** The same table, written so a read picked by a name the compiler only knows as `N` is still callable. */
type ReadCalls = { [N in ReadName]: (...args: ReadArgs[N]) => Promise<ReadResults[N]> };
/** The reads that take arguments: the only ones that can wait on them. */
export type ReadNameWithArgs = { [N in ReadName]: ReadArgs[N] extends readonly [] ? never : N }[ReadName];

/**
 * An invalidation may name fewer arguments than the read — `readKey("session")`
 * is every session — or an id the page has not resolved yet.
 *
 * Fewer means left out, never passed as `undefined` or `null`. A filter matches
 * a key by prefix, element by element, and TanStack's `partialMatchKey`
 * compares such an element like any other: `readKey("authAttention",
 * projectId, undefined)` matches no run's key, where `readKey("authAttention",
 * projectId)` matches them all. As a query's own key, a trailing `undefined`
 * is harmless.
 */
type KeyArgs<Args extends readonly unknown[]> = { [I in keyof Args]?: Args[I] | null };

export function readKey<N extends ReadName>(name: N, ...args: KeyArgs<ReadArgs[N]>) {
  return [name, ...args] as const;
}

const READ_OPTIONS: { readonly [N in ReadName]?: { readonly staleTime: number } } = {
  session: { staleTime: 5 * 60_000 },
};

/**
 * The query options for the reads one transport carries: every read on
 * `webClient` in the browser (`readQuery`), `apiReads` alone in process on the
 * server (`serverReadQuery`). A read is looked up when it runs, so a spy on
 * `webClient` sees it.
 */
export function readQueries<Names extends ReadName>(reads: Pick<ReadCalls, Names>) {
  return <N extends Names>(name: N, ...args: ReadArgs[N]) => queryOptions({
    ...READ_OPTIONS[name],
    queryKey: readKey(name, ...args),
    queryFn: () => {
      const read: ReadCalls[N] = reads[name];
      return read(...args);
    },
  });
}

/**
 * `readQueries` for a read whose arguments are not all at hand: an id another
 * read has yet to answer, or a read that does not apply here. `args` is null
 * until every one is. Until then the query is skipped (`skipToken`) under the
 * read's name alone, an entry every such waiting observer shares and no read
 * of it can refetch; once they are, it reads under the read's full key, the
 * key `readQueries` gives it.
 */
export function readQueriesWhen<Names extends ReadNameWithArgs>(reads: Pick<ReadCalls, Names>) {
  return <N extends Names>(name: N, args: ReadArgs[N] | null) => queryOptions({
    ...READ_OPTIONS[name],
    queryKey: args ? readKey(name, ...args) : ([name] as const),
    queryFn: args
      ? () => {
        const read: ReadCalls[N] = reads[name];
        return read(...args);
      }
      : skipToken,
  });
}

/** A read of a log from a point on: what was written after it, and where the next read goes on from. */
export interface LogRead<Event> {
  events: readonly Event[];
  nextAfter: number;
}

/**
 * A run's log kept append-only in the cache: each read asks for everything
 * written after the last event the cache holds, and adds it. On the server,
 * which holds nothing yet, that is the whole log so far; a poll adds what the
 * run wrote since. The key names the run whose log it is (a report's
 * `eventsRunId`), not a cursor: another attempt's log is another log. With no
 * reader — a log whose run is not known yet — the query waits (`skipToken`).
 */
function appendOnlyLog<Log extends LogRead<unknown>, Key extends QueryKey>(
  queryKey: Key,
  readAfter: ((after: number) => Promise<Log>) | null,
) {
  const log = queryOptions<Log, Error, Log, Key>({
    queryKey,
    queryFn: readAfter
      ? async ({ client }): Promise<Log> => {
        const held = client.getQueryData(log.queryKey);
        const read = await readAfter(held?.nextAfter ?? 0);
        return { ...read, events: [...(held?.events ?? []), ...read.events] };
      }
      : skipToken,
  });
  return log;
}

/** A shared run's progress, as one append-only log. */
export function publicEventLog(reads: Pick<ApiReads, "publicEvents">, token: string, runId: string) {
  return appendOnlyLog(readKey("publicEvents", token, runId), (after) => reads.publicEvents(token, runId, after));
}

/**
 * A run page's execution log, as one append-only log: the log of the run the
 * page names (`eventsRunId`), null until the page is read. The page's own read
 * carries none of it, so a page read again every few seconds reads only what
 * its log gained.
 */
export function verificationLog(
  reads: Pick<ApiReads, "verificationLog">,
  projectId: string,
  runId: string,
  eventsRunId: string | null,
) {
  return appendOnlyLog(
    readKey("verificationLog", projectId, runId, eventsRunId),
    eventsRunId === null ? null : (after) => reads.verificationLog(projectId, runId, eventsRunId, after),
  );
}
