// Thin entry for the Activity runner, which lives in ./activity-runner/.
// This path is the container contract — src/activity-runtime.ts and
// src/vercel-sandbox-runtime.ts spawn /shipbash/runtime/activity-runner.mjs by
// path — so it stays, re-exporting the runner's public surface and
// dispatching to the directory's main.
import { pathToFileURL } from "node:url";

import { main } from "./activity-runner/main.mjs";
import { nameUnlistedUid } from "./uid-name.mjs";

export {
  AGENT_BROWSER_MCP_ENV_VARS,
  activityDeadlineRemainingMs,
  activityWallMs,
  validateActivity,
} from "./activity-runner/environment.mjs";
export { redactActivityValue } from "./activity-runner/redaction.mjs";
export {
  activityBrowserWindowFromXwininfo,
  humanAuthPassword,
} from "./activity-runner/display.mjs";
export { agentBrowserDiagnostics } from "./activity-runner/browser.mjs";
export {
  buildActivityPrompt,
} from "./activity-runner/agent-session.mjs";
export {
  parseActivityProgressEvent,
  progressAgentAction,
  startActivityProgressReader,
} from "./activity-runner/progress-reader.mjs";
export { isAuthCandidatePending } from "./activity-runner/state.mjs";
export {
  browserLifecycleFaultResult,
  cloudflareActivityResult,
  validateActivityResult,
} from "./activity-runner/results.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await nameUnlistedUid();
  await main();
}
