import type { RouteContext } from "./route-support.ts";

/** Answers the request and returns true, or returns false for the next handler to try. */
export type RouteHandler = (context: RouteContext) => Promise<boolean>;

/** Tries each handler in order; the first that answers ends the search. */
export function firstHandled(...handlers: readonly RouteHandler[]): RouteHandler {
  return async (context) => {
    for (const handler of handlers) {
      if (await handler(context)) return true;
    }
    return false;
  };
}
