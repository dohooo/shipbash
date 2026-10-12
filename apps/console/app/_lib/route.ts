import type { Route } from "next";

/**
 * An address this app assembled at runtime, declared as the route it is.
 *
 * Typed routes are literal types read off the route tree, so a href built from
 * a `Route` the app already produced — `teamHref(…)` plus a query string —
 * widens to `string` and loses the shape the checker matched. Nothing at
 * runtime can check it back: the route tree exists only at build time, so this
 * is a declaration rather than a guard, and the overload pair is what states it
 * without asserting over the value. It is honest only for hrefs whose path came
 * from one of those helpers, or for a runtime address already proven to be a
 * same-site relative path (the login page's `next`, which `safeSameSitePath`
 * has vetted).
 *
 * The declaration lives here alone rather than at each call site.
 */
export function route(href: string): Route;
export function route(href: string): string {
  return href;
}
