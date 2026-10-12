import { matchApiPath } from "@shipbash/contracts/api/path-match";

import type { RouteContext } from "./route-support.ts";

/**
 * The first of `routes` whose method and path this request has, with the raw
 * path segments it names — the same template match the API's front gate makes.
 */
export function matchRoute<Routes extends ReadonlyArray<{ readonly method: string; readonly path: string }>>(
  context: RouteContext,
  ...routes: Routes
): { route: Routes[number]; raw: Record<string, string> } | null {
  for (const route of routes) {
    if (context.request.method !== route.method) continue;
    const raw = matchApiPath(route.path, context.url.pathname);
    if (raw) return { route, raw };
  }
  return null;
}
