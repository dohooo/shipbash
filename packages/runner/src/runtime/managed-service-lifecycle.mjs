/**
 * Spawning and readiness for the display and viewer processes both container
 * runners supervise. Every helper takes the runner-bound dependencies as its
 * first argument, so the factory in ./managed-services.mjs stays wiring and the
 * teardown strategies stay the only behaviour that differs between runners.
 */
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { childIsRunning } from "./child-process.mjs";

/**
 * The supervised child, described by what the supervisor actually touches. A
 * real ChildProcess satisfies it; so does a double that does not fake the
 * other thirty members.
 * @typedef {object} ManagedChild
 * @property {number | null} exitCode
 * @property {string | null} signalCode
 * @property {(signal: NodeJS.Signals) => boolean} kill
 * @property {{ destroy: () => void } | null} stderr
 */

/**
 * @typedef {object} ManagedService
 * @property {string} name
 * @property {ManagedChild} child
 * @property {Record<string, string | undefined>} env
 * @property {Error | null} spawnError
 * @property {Promise<{ code: number | null, signal: string | null }>} closed
 */

/**
 * The runner-bound collaborators. register and unregister are sinks: the
 * supervisor hands them the child it spawned and reads nothing back, so they
 * are typed by what is handed over, not by what the supervisor needs.
 * @typedef {object} ManagedServiceDeps
 * @property {(child: import("node:child_process").ChildProcess) => void} register
 * @property {(child: import("node:child_process").ChildProcess) => void} unregister
 * @property {string} workDirectory
 * @property {(stderr: import("node:stream").Readable | null) => void} pipeStderr
 * @property {(error: Error) => string} safeError
 * @property {() => void} checkCancellation
 */

/**
 * @param {number} port
 * @returns {Promise<boolean>} whether 127.0.0.1:port accepted a connection.
 */
function tcpPortIsOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(100);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

/**
 * Spawn one service, register its child, and pipe its redacted stderr.
 * @param {ManagedServiceDeps} deps
 * @param {string} name
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns the service, whose closed promise settles when the child exits.
 */
export function startManagedService(deps, name, command, args, env) {
  const child = spawn(command, args, {
    cwd: deps.workDirectory,
    env,
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
  });
  deps.register(child);
  deps.pipeStderr(child.stderr);
  const service = {
    name,
    child,
    env,
    spawnError: null,
    closed: null,
  };
  service.closed = new Promise((resolve) => {
    child.once("error", (error) => {
      service.spawnError = error;
    });
    child.once("close", (code, signal) => {
      deps.unregister(child);
      resolve({ code, signal });
    });
  });
  return service;
}

/**
 * @param {ManagedServiceDeps} deps
 * @param {ManagedService} service
 * @returns {Error} the redacted failure to report for a service that is gone.
 */
export function managedServiceError(deps, service) {
  if (service.spawnError) {
    return new Error(`${service.name} failed to start: ${deps.safeError(service.spawnError)}`);
  }
  return new Error(
    `${service.name} exited unexpectedly (code ${service.child.exitCode ?? "none"}, signal ${service.child.signalCode ?? "none"}).`,
  );
}

/**
 * Let a freshly spawned service settle, then confirm it is still up.
 * @param {ManagedServiceDeps} deps
 * @param {ManagedService} service
 * @param {number} settleMs
 * @returns {Promise<void>}
 */
export async function assertManagedServiceRunning(deps, service, settleMs) {
  await Promise.race([
    delay(settleMs),
    service.closed.then(() => {
      throw managedServiceError(deps, service);
    }),
  ]);
  deps.checkCancellation();
  if (!childIsRunning(service.child)) {
    throw managedServiceError(deps, service);
  }
}

/**
 * @param {ManagedServiceDeps} deps
 * @param {string} path
 * @param {ManagedService} service
 * @param {number} timeoutMs
 * @returns {Promise<void>} resolved once the path exists.
 */
export async function waitForPath(deps, path, service, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    deps.checkCancellation();
    if (!childIsRunning(service.child)) {
      throw managedServiceError(deps, service);
    }
    if (existsSync(path)) {
      return;
    }
    await delay(50);
  }
  throw new Error(`${service.name} did not become ready within ${timeoutMs} ms.`);
}

/**
 * @param {ManagedServiceDeps} deps
 * @param {number} port
 * @param {ManagedService} service
 * @param {number} timeoutMs
 * @returns {Promise<void>} resolved once the port accepts a connection.
 */
export async function waitForTcpPort(deps, port, service, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    deps.checkCancellation();
    if (!childIsRunning(service.child)) {
      throw managedServiceError(deps, service);
    }
    if (await tcpPortIsOpen(port)) {
      return;
    }
    await delay(50);
  }
  throw new Error(`${service.name} did not listen on port ${port} within ${timeoutMs} ms.`);
}

/**
 * @param {ManagedService[]} services
 * @param {number} timeoutMs
 * @returns the still-pending close of every service, and whether the budget
 * ran out before they all settled.
 */
export async function waitForManagedServices(services, timeoutMs) {
  const allClosed = Promise.all(services.map((service) => service.closed));
  let timedOut = false;
  let timeout;
  await Promise.race([
    allClosed,
    new Promise((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    }),
  ]);
  clearTimeout(timeout);
  return { allClosed, timedOut };
}
