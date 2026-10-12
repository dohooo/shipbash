// Thin entry for the Vercel Sandbox runtime, which lives in
// ./vercel-sandbox-runtime/. Importers (vercel-sandbox-task) keep this
// path; the directory is the map: task-tree paths, the on-disk task
// directory, the child environment allowlist, the browser-stream decoration,
// the child process dispatch, the option resolution, and the two run
// lifecycles each live in their own module.
export { createVercelSandboxRuntimeAdapters } from "./vercel-sandbox-runtime/adapters.ts";
export type { VercelSandboxBrowserStream } from "./vercel-sandbox-runtime/browser-stream.ts";
export {
  VERCEL_SANDBOX_AGENT_GID,
  VERCEL_SANDBOX_AGENT_UID,
} from "./vercel-sandbox-runtime/configuration.ts";
