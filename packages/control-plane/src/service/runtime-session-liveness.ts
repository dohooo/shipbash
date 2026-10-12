/**
 * Enforcement of the Runtime Session invariant: an Activity is in a waiting
 * state if and only if a live, adoptable container backs it.
 *
 * Nothing here consults the service's memory. Open sessions come from the
 * durable registry and liveness comes from Docker, so the answer is the same
 * whether the process has been up for a week or four seconds.
 */
import { spawn } from "node:child_process";

import type { RuntimeSessionRecord } from "../store/runtime-sessions.ts";

export const RUNTIME_SESSION_DEAD_REASON =
  "The controlled browser session ended while waiting for a human.";

/**
 * A container that has just been asked to start has not necessarily appeared in
 * `docker ps` yet. Calling it dead inside that window would terminalize healthy
 * work, so young sessions are left alone for one sweep.
 */
export const RUNTIME_SESSION_STARTUP_GRACE_MS = 60_000;

const MANAGED_LABEL = "io.shipbash.runner.managed";

/**
 * Names of the ShipBash-managed containers Docker reports as running.
 *
 * One `docker ps` answers "is this container alive?" for every open session at
 * once, which is what lets the reconciler run on a short cadence without a
 * per-session `docker inspect` storm. A name absent from this set is dead —
 * Docker is the authority, never the service's memory.
 */
export function listRunningManagedContainerNames(
  dockerBinary = "docker",
): Promise<Set<string>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      dockerBinary,
      ["ps", "--filter", `label=${MANAGED_LABEL}=true`, "--format", "{{.Names}}"],
      { shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`docker ps failed: ${stderr.trim().slice(0, 200)}`));
        return;
      }
      resolvePromise(new Set(
        stdout.split(/\r?\n/).map((value) => value.trim()).filter((value) => value.length > 0),
      ));
    });
  });
}

export interface RuntimeSessionLivenessResult {
  /** Sessions whose container is still running; safe to adopt and to spare. */
  alive: RuntimeSessionRecord[];
  /** Sessions whose container is gone. */
  dead: RuntimeSessionRecord[];
}

/**
 * Splits open sessions into survivors and casualties.
 *
 * Boot adoption and the periodic sweep are the same operation — the only
 * difference is that boot also uses `alive` to spare those containers from the
 * Project container sweep.
 */
export function classifyRuntimeSessions(
  sessions: readonly RuntimeSessionRecord[],
  running: ReadonlySet<string>,
  now: number,
  graceMs: number = RUNTIME_SESSION_STARTUP_GRACE_MS,
): RuntimeSessionLivenessResult {
  const alive: RuntimeSessionRecord[] = [];
  const dead: RuntimeSessionRecord[] = [];
  for (const session of sessions) {
    if (running.has(session.containerName)) {
      alive.push(session);
      continue;
    }
    const startedAt = Date.parse(session.startedAt);
    if (Number.isFinite(startedAt) && now - startedAt < graceMs) continue;
    dead.push(session);
  }
  return { alive, dead };
}
