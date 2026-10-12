/**
 * The managed-service supervisor both container runners spawn their display
 * and viewer processes through. The factory binds each runner's registry,
 * redacted stderr pipe, error redaction, and cancellation check onto the
 * lifecycle helpers in ./managed-service-lifecycle.mjs; the two teardown
 * strategies live here and stay separate on purpose — the suite runner closes
 * Chromium windows first so profiles flush, while the Activity runner
 * detaches inherited stderr pipes so a forked websockify worker can never
 * strand the auth hand-back.
 */
import { setTimeout as delay } from "node:timers/promises";

import { childIsRunning } from "./child-process.mjs";
import {
  assertManagedServiceRunning,
  managedServiceError,
  startManagedService,
  waitForManagedServices,
  waitForPath,
  waitForTcpPort,
} from "./managed-service-lifecycle.mjs";

/** @typedef {import("./managed-service-lifecycle.mjs").ManagedService} ManagedService */

/**
 * The cancellation-aware child runner, narrowed to this module's one call:
 * wmctrl, with a display env, uncancelable so teardown survives a cancel, and
 * a one-second budget. Only code, stdout and timedOut are ever read back.
 * @typedef {object} RunProcessOptions
 * @property {Record<string, string | undefined>} env
 * @property {boolean} cancelable
 * @property {number} timeoutMs
 */

/**
 * @typedef {(command: string, args: string[], options: RunProcessOptions) => Promise<{ code: number, stdout: string, timedOut: boolean }>} RunProcess
 */

/**
 * @param {string} wmctrlOutput a `wmctrl -lx` listing.
 * @returns {string[]} every distinct Chromium window id in it.
 */
export function chromiumWindowIds(wmctrlOutput) {
  const ids = [];
  for (const line of String(wmctrlOutput).split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (/^0x[0-9a-f]+$/i.test(fields[0] ?? "") && /chromium/i.test(fields[3] ?? "")) {
      ids.push(fields[0]);
    }
  }
  return [...new Set(ids)];
}

/**
 * Bind the window-closing teardown to one runner's cancellation-aware
 * runProcess. Only the suite runner supplies one; without it the wmctrl call
 * throws, the close is never confirmed, and the strategy falls back to signals.
 * @param {RunProcess | null} runProcess
 * @returns the teardown that closes Chromium windows before signalling.
 */
function createChromiumTeardown(runProcess) {
  /**
   * @param {ManagedService} service
   * @returns {Promise<boolean>} whether the window manager accepted a close.
   */
  async function closeChromiumWindows(service) {
    let listed;
    try {
      listed = await runProcess("wmctrl", ["-lx"], {
        env: service.env,
        cancelable: false,
        timeoutMs: 1_000,
      });
    } catch {
      return false;
    }
    if (listed.code !== 0 || listed.timedOut) {
      return false;
    }
    const ids = chromiumWindowIds(listed.stdout);
    if (ids.length === 0) {
      return false;
    }
    const results = await Promise.all(
      ids.map((id) =>
        runProcess("wmctrl", ["-i", "-c", id], {
          env: service.env,
          cancelable: false,
          timeoutMs: 1_000,
        }).catch(() => null),
      ),
    );
    return results.some((result) => result?.code === 0 && !result.timedOut);
  }

  /**
   * @param {ManagedService[]} services
   * @returns {Promise<void>}
   */
  async function stopManagedServicesClosingChromium(services) {
    const chromium = services.find((service) => service.name === "Chromium");
    if (chromium) {
      if (childIsRunning(chromium.child)) {
        const closeRequested = await closeChromiumWindows(chromium);
        if (closeRequested) {
          await waitForManagedServices([chromium], 3_000);
        }
      }
      if (childIsRunning(chromium.child)) {
        chromium.child.kill("SIGTERM");
      }
      const chromiumWait = await waitForManagedServices([chromium], 2_000);
      if (chromiumWait.timedOut) {
        if (childIsRunning(chromium.child)) {
          chromium.child.kill("SIGKILL");
        }
        await chromiumWait.allClosed;
      }
    }

    const remaining = services.filter((service) => service !== chromium);
    for (const service of [...remaining].reverse()) {
      if (childIsRunning(service.child)) {
        service.child.kill("SIGTERM");
      }
    }
    const remainingWait = await waitForManagedServices(remaining, 2_000);
    const timedOut = remainingWait.timedOut;
    if (timedOut) {
      for (const service of [...remaining].reverse()) {
        if (childIsRunning(service.child)) {
          service.child.kill("SIGKILL");
        }
      }
      await remainingWait.allClosed;
    }
  }

  return stopManagedServicesClosingChromium;
}

/**
 * @param {ManagedService[]} services
 * @returns {Promise<void>}
 */
async function stopManagedServicesDetachingStderr(services) {
  for (const service of [...services].reverse()) {
    if (childIsRunning(service.child)) service.child.kill("SIGTERM");
  }
  await Promise.race([
    Promise.all(services.map((service) => service.closed)),
    delay(2_000),
  ]);
  for (const service of services) {
    if (childIsRunning(service.child)) service.child.kill("SIGKILL");
  }
  // websockify forks per-client workers that inherit its stderr pipe. The
  // parent can be gone while Node still waits forever for those inherited
  // descriptors to close, which used to strand the auth hand-back in
  // waiting_for_auth. Cleanup is best effort and must never block the Agent.
  await Promise.race([
    Promise.all(services.map((service) => service.closed)),
    delay(1_000),
  ]);
  for (const service of services) service.child.stderr?.destroy();
}

/**
 * @param {object} options one runner's registry, redaction and cancellation.
 * @param {(child: import("node:child_process").ChildProcess) => void} options.register
 * @param {(child: import("node:child_process").ChildProcess) => void} options.unregister
 * @param {string} options.workDirectory
 * @param {(stderr: import("node:stream").Readable | null) => void} options.pipeStderr
 * @param {(error: Error) => string} options.safeError
 * @param {() => void} options.checkCancellation
 * @param {number} [options.waitTimeoutMs]
 * @param {RunProcess | null} [options.runProcess]
 * @returns the managed-service supervisor bound to that runner.
 */
export function createManagedServices({
  register,
  unregister,
  workDirectory,
  pipeStderr,
  safeError,
  checkCancellation,
  waitTimeoutMs = 5_000,
  runProcess = null,
}) {
  const deps = { register, unregister, workDirectory, pipeStderr, safeError, checkCancellation };
  return {
    startManagedService: (name, command, args, env) =>
      startManagedService(deps, name, command, args, env),
    managedServiceError: (service) => managedServiceError(deps, service),
    assertManagedServiceRunning: (service, settleMs = 150) =>
      assertManagedServiceRunning(deps, service, settleMs),
    waitForPath: (path, service, timeoutMs = waitTimeoutMs) =>
      waitForPath(deps, path, service, timeoutMs),
    waitForTcpPort: (port, service, timeoutMs = waitTimeoutMs) =>
      waitForTcpPort(deps, port, service, timeoutMs),
    waitForManagedServices,
    stopManagedServicesClosingChromium: createChromiumTeardown(runProcess),
    stopManagedServicesDetachingStderr,
  };
}
