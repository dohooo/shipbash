/**
 * Local-service constants and the runtime dependency table the service composes over.
 */
import type {
  reconcileProjectContainers,
  runSuiteInDocker,
} from "../docker-runtime.ts";
import type {
  captureHumanAuthCandidate,
  startHumanAuthSession,
  stopHumanAuthSession,
} from "../human-auth.ts";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4173;
export const MAX_BODY_BYTES = 1_000_000;
export const MAX_EVENT_TEXT = 1_000;
export const REDACTED = "[REDACTED]";

export interface ServiceDependencies {
  startHumanAuthSession: typeof startHumanAuthSession;
  stopHumanAuthSession: typeof stopHumanAuthSession;
  captureHumanAuthCandidate: typeof captureHumanAuthCandidate;
  runSuiteInDocker: typeof runSuiteInDocker;
  reconcileProjectContainers: typeof reconcileProjectContainers;
}
