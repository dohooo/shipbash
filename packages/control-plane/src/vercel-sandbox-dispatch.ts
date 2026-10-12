// Thin entry for Vercel Sandbox dispatch, which lives in
// ./vercel-sandbox-dispatch/. apps/console/workflows/vercel-sandbox-dispatch.ts
// is a "use workflow" module that imports this path, so nothing reachable from
// here may reach a Node builtin it cannot bundle; the directory is the map: the
// provider contract, the deterministic task name, the HTTP status reader, the
// origins a launch validates, the resolved provider options, the provider's
// acquire and launch steps, and the stop that ends a task Sandbox each live in
// their own module.
export type {
  VercelSandboxExecutionProvider,
  VercelSandboxLaunch,
} from "./vercel-sandbox-dispatch/execution-contract.ts";
export { createVercelSandboxExecutionProvider } from "./vercel-sandbox-dispatch/provider.ts";
export type { VercelSandboxProviderOptions } from "./vercel-sandbox-dispatch/provider-options.ts";
export { type RuntimeBundle, resolveRuntimeBundle } from "./vercel-sandbox-dispatch/runtime-bundle.ts";
export { stopTaskSandbox } from "./vercel-sandbox-dispatch/stop.ts";
export { vercelSandboxWorkspaceName } from "./vercel-sandbox-dispatch/workspace-names.ts";
