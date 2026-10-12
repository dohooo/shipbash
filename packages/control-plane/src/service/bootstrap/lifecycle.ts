/**
 * Bootstrap phase 7: the start()/close() lifecycle, and the mutable runtime
 * state it drives.
 *
 * The state record holds the mutable fields every phase reads and writes.
 * start() owns the init-order dependencies the wiring relies on — container
 * reconciliation before any lease, pg-boss registration before the launcher
 * starts, reconcilers only after the first reconcile pass — and close()
 * unwinds in the reverse order.
 */
import type { Server } from "node:http";

import type { ServiceGateways } from "./gateways.ts";
import type { ServiceLanes } from "./lanes.ts";
import type { ResolvedServiceConfig } from "./options.ts";
import type { ServiceStores } from "./stores.ts";
import type { DispatchWorkers } from "./dispatch-workers.ts";

/** The composition root's mutable closure state, shared across phases. */
export interface ServiceRuntimeState {
  scheduleReconciler: NodeJS.Timeout | null;
  started: boolean;
  shuttingDown: boolean;
}

export function createServiceRuntimeState(): ServiceRuntimeState {
  return {
    scheduleReconciler: null,
    started: false,
    shuttingDown: false,
  };
}

/** Everything the two lifecycle halves close over, assembled by the root. */
interface ServiceLifecycleInput {
  config: ResolvedServiceConfig;
  stores: ServiceStores;
  state: ServiceRuntimeState;
  lanes: ServiceLanes;
  workers: DispatchWorkers;
  gateways: ServiceGateways;
  server: Server;
}

/**
 * The init order the wiring relies on: container reconciliation before any
 * lease, pg-boss registration before the launcher starts, and the reconciler
 * timers only after the first reconcile pass has run.
 */
async function startService(input: ServiceLifecycleInput): Promise<void> {
  const { config, stores, state, lanes, workers, server } = input;
  const { port, host } = config;
  const { jobQueue } = stores;
  const {
    inlineActivityAuthSessions,
    reconcileDispatchQueue,
    scheduleLane,
  } = lanes;
  const { reconcileSchedules } = scheduleLane;
  const { dispatchWorker, localDispatchLauncher } = workers;
  if (state.started) return;
  // Cleanup must complete before workers can lease a persisted task. Project
  // runtime containers use the logical Project id hash.
  await stores.reconcileKnownProjectContainers(await inlineActivityAuthSessions.sweep());
  if (jobQueue && dispatchWorker) {
    await jobQueue.start();
    await jobQueue.work({
      scheduleTick: scheduleLane.scheduleTick,
    });
    localDispatchLauncher?.start();
    await reconcileDispatchQueue();
    await reconcileSchedules();
    state.scheduleReconciler = setInterval(() => {
      void reconcileSchedules().catch(() => undefined);
      void inlineActivityAuthSessions.sweep().catch(() => undefined);
    }, 30_000);
    state.scheduleReconciler.unref();
  }
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  state.started = true;
}

/** Teardown unwinds start() in reverse; every step here is ordered. */
async function closeService(input: ServiceLifecycleInput): Promise<void> {
  const { stores, state, lanes, workers, gateways, server } = input;
  const { jobQueue } = stores;
  const { scheduleLane, taskAuthOwners } = lanes;
  const { localDispatchLauncher } = workers;
  const { authSessions } = gateways;
  state.shuttingDown = true;
  if (state.scheduleReconciler) clearInterval(state.scheduleReconciler);
  state.scheduleReconciler = null;
  await Promise.allSettled([
    ...(localDispatchLauncher ? [localDispatchLauncher.close()] : []),
    ...scheduleLane.pending(),
    ...(jobQueue ? [jobQueue.stop()] : []),
  ]);
  await Promise.allSettled([...authSessions.starts.values()]);
  await Promise.allSettled(
    taskAuthOwners.entries().map(([projectId, owner]) =>
      authSessions.stopTaskAuthSession(
        projectId,
        owner.sessionId,
        owner.targetKind,
        owner.targetId,
      )),
  );
  await Promise.allSettled([stores.reconcileKnownProjectContainers()]);
  if (state.started) {
    await new Promise<void>((resolvePromise, reject) =>
      server.close((error) => (error ? reject(error) : resolvePromise())),
    );
    state.started = false;
  }
  await gateways.slackWebhook?.chat.close();
  await stores.tenantStore?.close();
}

export function createServiceLifecycle(
  input: ServiceLifecycleInput,
): { start(): Promise<void>; close(): Promise<void> } {
  return {
    start: () => startService(input),
    close: () => closeService(input),
  };
}
