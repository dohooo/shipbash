/**
 * The ShipBash service composition root, phase by phase.
 *
 * The tree is the map: each file under src/service/bootstrap/ is one
 * construction phase, and this function is nothing but the phase order —
 * options resolved, stores and providers built, lanes and registries wired,
 * the dispatch worker pool assembled and bound to the wake handle the lanes
 * exposed, gateways stacked on the auth session registry, route channels
 * assembled into the server, and the lifecycle closed over all of it. The
 * order is load-bearing (reconciler timers, dispatch launcher, pg-boss
 * registration, auth registries); reorder nothing without reading every
 * phase header first.
 */
import { createDispatchWorkers } from "./dispatch-workers.ts";
import { createServiceGateways } from "./gateways.ts";
import { createServiceLanes } from "./lanes.ts";
import { createServiceLifecycle, createServiceRuntimeState } from "./lifecycle.ts";
import {
  resolveServiceConfig,
  type ShipBashService,
  type ShipBashServiceOptions,
} from "./options.ts";
import { createServiceServer } from "./route-channels.ts";
import { createServiceStores } from "./stores.ts";

export function createShipBashService(options: ShipBashServiceOptions): ShipBashService {
  const config = resolveServiceConfig(options);
  const stores = createServiceStores(options, config);
  const state = createServiceRuntimeState();
  const lanes = createServiceLanes({ options, config, stores });
  const workers = createDispatchWorkers({ options, config, stores, lanes });
  // The lanes handed reconcileDispatchQueue to the schedule lane before the
  // launcher existed; bind it now, before anything can wake the queue.
  lanes.bindDispatchLauncher(workers.localDispatchLauncher);
  const gateways = createServiceGateways({ config, stores, state, lanes });
  const server = createServiceServer({ config, stores, lanes, workers, gateways });
  const lifecycle = createServiceLifecycle({ config, stores, state, lanes, workers, gateways, server });
  return {
    server,
    projectRoot: config.projectRoot,
    shipbashDirectory: config.shipbashDirectory,
    baseUrl: config.baseUrl,
    start: lifecycle.start,
    close: lifecycle.close,
  };
}
