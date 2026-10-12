/**
 * What both lease preparations of a Sandbox task run against, built once per
 * task process: the job API, the worker's own store, and the task's own
 * configuration. The Sandbox holds no database, no storage and no key: every
 * read and write of ShipBash data is a call to the job API.
 */
import type { JobPort } from "../job-api/port.ts";
import type { RemoteWorkerStore } from "../job-api/remote.ts";
import type { SandboxTaskEnvironment } from "./environment.ts";

export interface SandboxTaskContext {
  port: JobPort;
  /** The store the task's DispatchWorker writes through: a preparation's events and sign-in writes join its queue, in order. */
  store: RemoteWorkerStore;
  configuration: SandboxTaskEnvironment;
  environment: NodeJS.ProcessEnv;
}
