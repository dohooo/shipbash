import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

import { buildContentSecurityPolicy } from "./lib/content-security-policy";

const contentSecurityPolicy = buildContentSecurityPolicy();

export const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
  // Nothing is cached unless it asks to be, and a route serves a prerendered
  // shell while its request-time parts stream in. Every page here reads the
  // selected project from the query string, so the shell is what makes a
  // navigation paint before the API has answered.
  cacheComponents: true,
  // One reusable shell prefetched per route instead of one prefetch per visible
  // link. The rail links to the same handful of routes from every page, so the
  // old behaviour re-fetched them on each render; this fetches each once.
  partialPrefetching: true,
  experimental: {
    // A page the reader has seen is drawn again from the router's cache, with
    // no request, for five minutes after it was read. Its data stays fresh
    // regardless: the page reads it through TanStack Query, which refetches
    // what is stale once the page is shown again. Five minutes is also how
    // long TanStack keeps a read no page observes, so the data a cached page
    // hands over is never older than what the browser still holds.
    staleTimes: { dynamic: 300 },
  },
  // A conversation's turn runs the pi SDK in its Workflow step: loaded from
  // node_modules at run time, never bundled (its codemode carries a wasm
  // loader Turbopack cannot resolve).
  serverExternalPackages: ["@earendil-works/pi-coding-agent"],
  async headers() {
    return [
      {
        // The GitHub install route answers a local App registration page with a
        // CSP of its own, whose form posts to github.com.
        source: "/((?!api/github/install(?:/|$)).*)",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default withWorkflow(nextConfig);
