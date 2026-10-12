import { randomUUID } from "node:crypto";

import { createJobApiClient } from "@shipbash/contracts/runtime/job-api.mjs";

import { DispatchWorker } from "../dispatch-worker.ts";
import type { DispatchWorkerOutcome } from "../dispatch-worker-types.ts";
import { remoteJobApi } from "../job-api/remote.ts";
import { throttledWorkProgress } from "../slack-chat/work-progress.ts";
import { createVercelSandboxRuntimeAdapters } from "../vercel-sandbox-runtime.ts";
import type { SandboxTaskContext } from "./context.ts";
import { ringSandboxDispatchBell } from "./dispatch-bell.ts";
import { vercelSandboxTaskEnvironment } from "./environment.ts";
import { sanitizedFailure } from "./failure.ts";
import { prepareActivityRuntime } from "./prepare-activity.ts";
import { prepareSuiteRuntime } from "./prepare-suite.ts";

/**
 * One sandboxed task: read the environment and run exactly one claimed Job
 * through the shared dispatch worker. Everything the task reads or writes
 * goes through the job API, which the Sandbox firewall's forward rule reaches
 * with the Sandbox's Vercel-signed identity (job-api/identity.ts): the VM
 * holds no credential of its own.
 */
export async function executeVercelSandboxTask(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DispatchWorkerOutcome> {
  const configuration = vercelSandboxTaskEnvironment(environment);
  const { port, store } = remoteJobApi(createJobApiClient({ endpoint: configuration.jobApiOrigin }));
  const adapters = createVercelSandboxRuntimeAdapters({
    rootDirectory: configuration.rootDirectory,
    runtimeDirectory: configuration.runtimeDirectory,
    environment,
    resolveBrowserStream: () => configuration.browserStream,
    onStderr(line) {
      const safe = sanitizedFailure(line);
      if (safe) process.stderr.write(`${safe}\n`);
    },
  });
  const controller = new AbortController();
  const cancel = () => controller.abort("sandbox_termination");
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  const context: SandboxTaskContext = { port, store, configuration, environment };
  // A run or a walk a conversation started is drawn in its thread's to-do
  // list as it moves, each draw painted by the server. The last draw is the
  // Workflow's, once this Sandbox has stopped: a settle from here would land
  // after the job's terminal write released the lease it is checked against.
  const progress = throttledWorkProgress(() => port.drawWorkProgress());
  try {
    const worker = new DispatchWorker({
      store,
      workerId: `vercel-sandbox-${randomUUID()}`,
      runSuite: adapters.runSuite,
      runActivity: adapters.runActivity,
      prepareSuite: (input, capability, signal) =>
        prepareSuiteRuntime(context, input, capability, signal),
      prepareActivity: (input, capability, signal) =>
        prepareActivityRuntime(context, input, capability, signal),
      // Rung as the leg closes (DispatchWorker.execute's finally): a walk
      // that ended or parked has by then reported to its conversation, which
      // queued the conversation's turn, and the wrapper tells this task's
      // Workflow to dispatch it now (dispatch-bell.ts), before the task has
      // closed and its completion, which dispatches again, is delivered. The
      // ring at a sign-in request comes before the park's report and
      // dispatches nothing. A walk's question is recorded in one write with
      // its report, so the ring as it asks, mid-leg, dispatches the turn that
      // answers it.
      onOwnerTurn: () => ringSandboxDispatchBell().catch((error: unknown) => {
        process.stderr.write(`${sanitizedFailure(error)}\n`);
      }),
      workProgress: {
        moved: (work) => progress.moved(work),
        changed: (work) => progress.changed(work),
        settle: (work) => progress.quiet(work),
      },
    });
    return await worker.execute({
      jobId: configuration.jobId,
      identityHash: configuration.identityHash,
      expectedKind: configuration.expectedKind,
    }, controller.signal);
  } finally {
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
  }
}
