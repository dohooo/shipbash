import { agentServices } from "@shipbash/contracts/runtime/agent-model.mjs";

import { startSuiteDisplay } from "./display.mjs";
import { stopManagedServices } from "./processes.mjs";
import { cleanBrowserEnvironment } from "./browser.mjs";
import { SIGN_IN_HEADLESS } from "./environment.mjs";
// The mode dispatcher: one container, five lanes (suite walk, human-auth
// viewer, parked idle browser, sign-in verification, automatic sign-in),
// selected by argv.
// Every lane funnels through the same cancellation envelope and teardown.
import { rawLog, safeError } from "./redaction.mjs";
import { CancellationError, emit } from "./state.mjs";
import { closeStreamGateway } from "./browser.mjs";
import { finalizePendingBrowserRecordings } from "./recording-output.mjs";
import { runBrowserIdle } from "./browser-idle.mjs";
import { runHumanAuth } from "./human-auth-lane.mjs";
import { runSignInLogin } from "./sign-in-login.mjs";
import { runSignInVerify } from "./sign-in-verify.mjs";
import { runSuite } from "./run-suite.mjs";

// The lane argv[2] names runs, else the suite walk.
const LANES = [
  ["human-auth", runHumanAuth],
  ["browser-idle", runBrowserIdle],
  ["sign-in-verify", runSignInVerify],
  ["sign-in-login", runSignInLogin],
];

export async function main() {
  const lane = process.argv[2];
  let display = [];
  const needsDisplay = !SIGN_IN_HEADLESS && lane !== "human-auth";
  try {
    // Every lane but the parked browser asks pi or Jev, so it refuses to start
    // without the agent services, naming every variable it lacks.
    if (lane !== "browser-idle") agentServices(process.env);
    if (needsDisplay) display = await startSuiteDisplay(cleanBrowserEnvironment());
    await (LANES.find(([name]) => name === lane)?.[1] ?? runSuite)();
  } catch (error) {
    if (error instanceof CancellationError) {
      emit("suite", "suite_canceled", {});
      process.exitCode = 130;
    } else {
      rawLog(safeError(error));
      emit("infrastructure", "infrastructure_error", {
        message: safeError(error),
      });
      process.exitCode = 1;
    }
  } finally {
    try {
      await finalizePendingBrowserRecordings();
      await closeStreamGateway();
    } finally {
      await stopManagedServices(display);
    }
  }
}
