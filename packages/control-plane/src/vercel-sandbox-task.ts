// Thin entry for the one-shot Vercel Sandbox task, which lives in
// ./vercel-sandbox-task/. The Dockerfile bundles this path, so it
// stays; the directory is the map: the stream origin
// reader, the environment reader, the failure redaction, the artifact walk
// and its retention, the repository checkouts, what both lease preparations
// share, the two preparations, the Suite finalization, the dispatch bell, and
// the run itself each live in their own module.
import { pathToFileURL } from "node:url";

import { executeVercelSandboxTask } from "./vercel-sandbox-task/execute.ts";
import { sanitizedFailure } from "./vercel-sandbox-task/failure.ts";

export { parseVercelSandboxBrowserStream } from "./vercel-sandbox-task/browser-stream-url.ts";
export { vercelSandboxTaskEnvironment } from "./vercel-sandbox-task/environment.ts";
export { executeVercelSandboxTask } from "./vercel-sandbox-task/execute.ts";

async function main(): Promise<void> {
  try {
    const outcome = await executeVercelSandboxTask();
    process.stdout.write(`${JSON.stringify({ outcome })}\n`);
  } catch (error) {
    process.stderr.write(`${sanitizedFailure(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
