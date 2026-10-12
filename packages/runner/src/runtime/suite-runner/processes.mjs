// Child-process factories wired to the suite runner's state module: the
// cancellation-aware runProcess and the managed-service supervisor share the
// same child registry so a SIGTERM reaches every live process.
import { createRunProcess } from "../child-process.mjs";
import { createManagedServices } from "../managed-services.mjs";

import { WORK_DIRECTORY } from "./environment.mjs";
import { pipeRedactedStderr, safeError } from "./redaction.mjs";
import {
  activeChildren,
  CancellationError,
  checkCancellation,
  isCancellationRequested,
  pollCancelRequested,
} from "./state.mjs";

export const runProcess = createRunProcess({
  register: (child) => activeChildren.add(child),
  unregister: (child) => activeChildren.delete(child),
  defaultCwd: WORK_DIRECTORY,
  defaultTimeoutMs: 120_000,
  pipeStderr: pipeRedactedStderr,
  checkCancellation,
  isCancelRequested: pollCancelRequested,
});

const managedServices = createManagedServices({
  register: (child) => activeChildren.add(child),
  unregister: (child) => activeChildren.delete(child),
  workDirectory: WORK_DIRECTORY,
  pipeStderr: pipeRedactedStderr,
  safeError,
  // The managed-service waits latch on the in-memory flag only; polling the
  // cancel sentinel file stays the run-process poll's concern.
  checkCancellation: () => {
    if (isCancellationRequested()) {
      throw new CancellationError();
    }
  },
  runProcess,
});
export const {
  startManagedService,
  managedServiceError,
  assertManagedServiceRunning,
  waitForPath,
  waitForTcpPort,
} = managedServices;
export const stopManagedServices = managedServices.stopManagedServicesClosingChromium;
