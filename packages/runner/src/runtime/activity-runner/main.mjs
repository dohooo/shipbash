// The Activity runner's process envelope: a low-volume health heartbeat, the
// single runActivity lane, and the error/cancellation exit contract.
import { freemem, loadavg } from "node:os";

import { agentServices } from "@shipbash/contracts/runtime/agent-model.mjs";

import { CancellationError, currentActivityId, emit } from "./state.mjs";
import { closeStreamGateway } from "./browser.mjs";
import { runtimeFailureDiagnostics, runtimeFailureMessage } from "./results.mjs";
import { runActivity } from "./run-activity.mjs";

export async function main() {
  // Low-volume memory heartbeat on stderr: visible in a live sandbox log tail
  // so resource exhaustion leaves a trace even when the whole VM dies.
  const healthTimer = setInterval(() => {
    try {
      process.stderr.write(`[shipbash-health] rss=${String(Math.round(process.memoryUsage().rss / 1_048_576))}MB free=${String(Math.round(freemem() / 1_048_576))}MB load=${loadavg()[0].toFixed(2)}\n`);
    } catch {
      // Telemetry only.
    }
  }, 60_000);
  healthTimer.unref();
  try {
    // The leg asks pi and Jev: it refuses to start without them, naming every variable it lacks.
    agentServices(process.env);
    await runActivity();
  } catch (error) {
    if (error instanceof CancellationError) {
      process.exitCode = 130;
    } else {
      const message = runtimeFailureMessage(error);
      process.stderr.write(`${message}\n`);
      if (currentActivityId()) {
        emit("warning", "Activity runtime failed", {
          bodyMarkdown: message,
          safeData: await runtimeFailureDiagnostics(error),
        });
      }
      process.exitCode = 1;
    }
  } finally {
    clearInterval(healthTimer);
    await closeStreamGateway();
  }
}
