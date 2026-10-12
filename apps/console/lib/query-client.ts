import { environmentManager, MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

import { ApiError } from "./api-client";
import { readKey } from "./queries";
import { recover } from "./session-recovery";

/**
 * One more try, and only where it can help. A 4xx is the service's answer and
 * asking again gets the same one. The server never retries: its transport
 * answers each path once per render, so a second try would get the same
 * failure. A read the server could not make is the route's error instead
 * (WorkspacePage, SharedRun), whose Try again reads it on the server anew;
 * one the page tolerates is left out of what the page hands the browser,
 * which asks again.
 */
function retryOnce(failureCount: number, error: unknown): boolean {
  if (environmentManager.isServer()) return false;
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 1;
}

/**
 * A request that finds the session gone recovers wherever it failed: a poll of
 * a page already on screen draws no error view to do it, and a write shows only
 * its inline error. Only in the browser; the server hands its failures to the
 * page (ServerReadError).
 */
function recoverInBrowser(error: unknown): void {
  if (!environmentManager.isServer()) recover(error);
}

/**
 * A direct write the journeys refused because they moved since the page
 * rendered them: whichever write it was, the journeys are read again, and
 * the write's inline error says why.
 */
function rereadMovedJourneys(error: unknown, client: QueryClient): void {
  if (error instanceof ApiError && error.code === "REVISION_CONFLICT") {
    void client.invalidateQueries({ queryKey: readKey("journeys") });
  }
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: recoverInBrowser }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _result, _mutation, { client }) => {
        recoverInBrowser(error);
        rereadMovedJourneys(error, client);
      },
    }),
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: retryOnce,
        // Above zero so data the server prefetched is not read again the
        // moment the page hydrates.
        staleTime: 30_000,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

/**
 * A new client for every server render, so no reader's data outlives their
 * request; one for the life of the tab in the browser. Not `useState`: a render
 * that suspends above a boundary would throw the state, and the cache, away.
 */
export function getQueryClient(): QueryClient {
  if (environmentManager.isServer()) return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}
