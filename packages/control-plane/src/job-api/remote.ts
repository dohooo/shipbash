/**
 * The job API from inside a Sandbox: the port the task's preparations call
 * and the dispatch worker's store, both every method of the same name sent
 * over the client, the store's with the capability argument dropped because
 * the server derives it from the job row (identity.ts). The claim sends only
 * its worker id. Only the contracts' method table is read here (job-api.mjs
 * JOB_METHOD_RETRY), never the methods themselves, so the executor carries
 * none of the server's dependencies.
 *
 * The worker's single event appends are written behind in batches
 * (event-queue.ts), and every `once` write, from the store or the port,
 * first waits for the events appended before it, so the record keeps the
 * order the task wrote it in. A batch that failed fails every write after
 * it, as a failed event write failed the run before the events were batched,
 * except the writes on the worker's way out that end the job (ENDINGS): a
 * lost batch still leaves the job failed, canceled or parked, with its
 * reason, instead of leased until its lease runs out. A completion is not
 * one of them: it fails on the lost batch, and the worker fails the job.
 */
import { JOB_METHOD_RETRY, type JobApiClient } from "@shipbash/contracts/runtime/job-api.mjs";

import type { DispatchWorkerStore } from "../dispatch-worker-types.ts";
import type { AppendActivityEventForJobInput, AppendRunEventForJobInput } from "../store/job-store-inputs.ts";
import type { SignInWrites } from "../task-sign-in.ts";
import { EventQueue } from "./event-queue.ts";
import type { JobPort } from "./port.ts";
import type { JobMethodName } from "./registry.ts";

/** The batch appends the queues send; the worker itself appends one event at a time. */
const BATCHES: ReadonlySet<JobMethodName> = new Set(["appendRunEventsForJob", "appendActivityEventsForJob"]);
const QUEUED = ["appendRunEventForJob", "appendActivityEventForJob"];
const ENDINGS: ReadonlySet<JobMethodName> = new Set([
  "markDispatchFinalizationFailed",
  "releaseDispatchJobWaitingForAuth",
  "failDispatchJob",
  "cancelDispatchJob",
]);

function isMethodName(name: string): name is JobMethodName {
  return Object.hasOwn(JOB_METHOD_RETRY, name);
}

const METHOD_NAMES = Object.keys(JOB_METHOD_RETRY).filter(isMethodName);

function isJobPort(port: Partial<Record<JobMethodName, unknown>>): port is JobPort {
  return METHOD_NAMES.every((name) => typeof port[name] === "function");
}

/** The worker's store, and the sign-in writes a task's preparation makes through it. */
export type RemoteWorkerStore = DispatchWorkerStore & SignInWrites;

function isRemoteWorkerStore(store: object): store is RemoteWorkerStore {
  return [...METHOD_NAMES.filter((name) => !BATCHES.has(name)), ...QUEUED]
    .every((name) => typeof Reflect.get(store, name) === "function");
}

export interface RemoteJobApi {
  port: JobPort;
  store: RemoteWorkerStore;
}

export function remoteJobApi(client: JobApiClient): RemoteJobApi {
  const send = (name: JobMethodName, args: unknown[]) => client.call(name, args);
  const runEvents = new EventQueue<AppendRunEventForJobInput>((events) => send("appendRunEventsForJob", [events]));
  const activityEvents = new EventQueue<AppendActivityEventForJobInput>((events) => send("appendActivityEventsForJob", [events]));
  /** A method in order: a write waits for the events appended before it. */
  const ordered = (name: JobMethodName) => async (...args: unknown[]) => {
    if (JOB_METHOD_RETRY[name] === "once") {
      await Promise.all([runEvents.written(), activityEvents.written()]).catch((error: unknown) => {
        if (!ENDINGS.has(name)) throw error;
      });
    }
    return send(name, args);
  };
  const port: Partial<Record<JobMethodName, (...args: unknown[]) => Promise<unknown>>> = {};
  for (const name of METHOD_NAMES) port[name] = ordered(name);
  if (!isJobPort(port)) throw new Error("The remote job port is missing a method.");

  const store: Record<string, (...args: never[]) => Promise<unknown>> = {
    // The job and its identity hash come from the forwarded identity and the row.
    claimDispatchJob: (_jobId: string, _identityHash: string, workerId: string) => send("claimDispatchJob", [workerId]),
    appendRunEventForJob: (_capability: unknown, event: AppendRunEventForJobInput) => runEvents.append(event),
    appendActivityEventForJob: (_capability: unknown, event: AppendActivityEventForJobInput) => activityEvents.append(event),
  };
  for (const name of METHOD_NAMES) {
    if (Object.hasOwn(store, name) || BATCHES.has(name)) continue;
    const call = ordered(name);
    store[name] = (_capability: unknown, ...args: unknown[]) => call(...args);
  }
  if (!isRemoteWorkerStore(store)) throw new Error("The remote worker store is missing a method.");
  return { port, store };
}
