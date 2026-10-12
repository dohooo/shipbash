/**
 * Bootstrap phase 3: the shared lanes and registries.
 *
 * Everything the worker pool and the gateways both wire against is built
 * here, in dependency order: task auth
 * plumbing, the dispatch wake handle, the schedule lane, and the inline activity session registry.
 * The dispatch launcher itself is a later phase; it plugs into the wake
 * handle exposed here (`bindDispatchLauncher`) once constructed.
 */
import { shipbashProcessEnvironmentValue } from "../../environment.ts";
import type { LocalDispatchLauncher } from "../../local-dispatch-launcher.ts";
import {
  createAuthHandoffOwnership,
  type AuthHandoffOwnership,
} from "../auth-handoff-ownership.ts";
import {
  createInlineActivitySessionRegistry,
  type InlineActivitySessionRegistry,
} from "../runtime-session-registry.ts";
import { createScheduleLane, type ScheduleLane } from "../schedule-lane.ts";
import { createTaskAuthPlumbing, type TaskAuthPlumbing } from "../task-auth-plumbing.ts";
import type { ResolvedServiceConfig, ShipBashServiceOptions } from "./options.ts";
import type { ServiceStores } from "./stores.ts";

export interface ServiceLanes {
  taskAuthPlumbing: TaskAuthPlumbing;
  reconcileDispatchQueue(): Promise<void>;
  /** Wired by the worker phase once the launcher exists; a no-op until then. */
  bindDispatchLauncher(launcher: LocalDispatchLauncher | null): void;
  scheduleLane: ScheduleLane;
  inlineActivityAuthSessions: InlineActivitySessionRegistry;
  taskAuthOwners: AuthHandoffOwnership;
}

export function createServiceLanes(input: {
  options: ShipBashServiceOptions;
  config: ResolvedServiceConfig;
  stores: ServiceStores;
}): ServiceLanes {
  const { options, config, stores } = input;
  const { shipbashDirectory } = config;
  const { tenantStore, github, jobQueue } = stores;

  const taskAuthPlumbing = createTaskAuthPlumbing({
    tenantStore,
    shipbashDirectory,
    runtimeTemporaryDirectory: options.runtimeTemporaryDirectory,
  });

  // The launcher is built by the worker phase; until bound, waking is a no-op.
  let dispatchLauncher: LocalDispatchLauncher | null = null;
  const bindDispatchLauncher = (launcher: LocalDispatchLauncher | null): void => {
    dispatchLauncher = launcher;
  };
  const reconcileDispatchQueue = async (): Promise<void> => {
    await dispatchLauncher?.wake();
  };
  const scheduleLane = createScheduleLane({
    jobQueue,
    tenantStore,
    github,
    reconcileDispatchQueue,
  });

  const inlineActivityAuthSessions = createInlineActivitySessionRegistry(
    () => (tenantStore ? tenantStore.internal.runtimeSessionsSql() : null),
    shipbashProcessEnvironmentValue("DOCKER_BINARY"),
  );
  const taskAuthOwners = createAuthHandoffOwnership();

  return {
    taskAuthPlumbing,
    reconcileDispatchQueue,
    bindDispatchLauncher,
    scheduleLane,
    inlineActivityAuthSessions,
    taskAuthOwners,
  };
}
