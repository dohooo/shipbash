/**
 * The three waits between `docker run` and a viewer a human can use: the
 * runner's readiness event on stdout, the published viewer port, and the noVNC
 * page answering. Each re-checks that the container is still alive, so a
 * container that dies during startup fails fast instead of burning the budget.
 */
import { isNonNullObject } from "../is-record.ts";
import { POLL_INTERVAL_MS, inspectRunning, missingContainer, run } from "./docker.ts";

const STARTUP_TIMEOUT_MS = 30_000;

export async function waitForPublishedViewerPort(
  command: string,
  containerName: string,
): Promise<number> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await run(command, ["port", containerName, "6080/tcp"]);
    if (result.exitCode === 0) {
      const match = result.stdout.match(/127\.0\.0\.1:(\d+)\s*$/m);
      const port = match ? Number(match[1]) : 0;
      if (port > 0 && port <= 65_535) return port;
    } else if (missingContainer(result)) {
      throw new Error("The human auth container exited before publishing its viewer port.");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS));
  }
  throw new Error("Docker did not publish the human auth viewer port within 30 seconds.");
}

function outputHasHumanAuthReady(output: string): boolean {
  return output.split(/\r?\n/).some((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return isNonNullObject(value) && value.type === "human_auth_ready";
    } catch {
      return false;
    }
  });
}

export async function waitForRunnerReady(command: string, containerName: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const running = await inspectRunning(command, containerName);
    if (running === null || running === false) {
      throw new Error("The human auth container exited before reporting readiness.");
    }
    const logs = await run(command, ["logs", "--tail", "100", containerName]);
    if (logs.exitCode === 0 && outputHasHumanAuthReady(logs.stdout)) return;
    if (logs.exitCode !== 0 && missingContainer(logs)) {
      throw new Error("The human auth container exited before reporting readiness.");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS));
  }
  throw new Error("The human auth runner did not report readiness within 30 seconds.");
}

export async function waitForViewer(
  command: string,
  containerName: string,
  viewerUrl: string,
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const running = await inspectRunning(command, containerName);
    if (running === null || running === false) {
      throw new Error("The human auth container exited before its viewer became ready.");
    }
    try {
      const response = await fetch(viewerUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(1_000),
      });
      const ready = response.status >= 200 && response.status < 400;
      await response.body?.cancel();
      if (ready) return;
    } catch {
      // noVNC may still be starting after Docker has published the port.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS));
  }
  throw new Error("The human auth viewer did not become ready within 30 seconds.");
}
