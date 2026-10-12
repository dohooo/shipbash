// Child-process factories wired to the Activity runner's state module: the
// cancellation-aware runProcess and the managed-service supervisor share the
// same child registry so a SIGTERM reaches every live process.
import { createRunProcess } from "../child-process.mjs";
import { createManagedServices } from "../managed-services.mjs";

import { DEFAULT_TIMEOUT_MS, REPOSITORY_ROOT, WORK_DIRECTORY } from "./environment.mjs";
import { pipeRedactedStderr, safeError } from "./redaction.mjs";
import {
  activeChildren,
  checkCancellation,
  getBrowserLifecycleFault,
  pollCancelRequested,
} from "./state.mjs";

const managedServices = createManagedServices({
  register: (child) => activeChildren.add(child),
  unregister: (child) => activeChildren.delete(child),
  workDirectory: WORK_DIRECTORY,
  pipeStderr: pipeRedactedStderr,
  safeError,
  checkCancellation,
  waitTimeoutMs: 15_000,
});
export const {
  startManagedService,
  assertManagedServiceRunning,
  waitForPath,
} = managedServices;
export const stopManagedServices = managedServices.stopManagedServicesDetachingStderr;

export const runProcess = createRunProcess({
  register: (child) => activeChildren.add(child),
  unregister: (child) => activeChildren.delete(child),
  defaultCwd: REPOSITORY_ROOT,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  pipeStderr: pipeRedactedStderr,
  checkCancellation,
  isCancelRequested: pollCancelRequested,
  isLifecycleFaulted: () => Boolean(getBrowserLifecycleFault()),
});
