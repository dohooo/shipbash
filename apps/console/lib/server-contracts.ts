/**
 * The server-only value surface `app/` route handlers may use from `src/`.
 *
 * The first import makes the boundary physical: a client component pulling
 * anything from this file fails the build with a named error instead of
 * bundling postgres and node built-ins into a page that 500s — the exact
 * regression that once took /login down. Client-safe values live in
 * `lib/client-contracts.ts`.
 */
import "server-only";

export { configuration, hostedConfiguration } from "@shipbash/control-plane/configuration";
export { sameSecret } from "@shipbash/control-plane/same-secret";
export { dispatchVercelSandboxWork } from "@shipbash/control-plane/vercel-sandbox-work";
export { handleJobApiRequest } from "@shipbash/control-plane/job-api/server";
