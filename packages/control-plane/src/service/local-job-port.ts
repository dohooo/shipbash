/**
 * The job API in-process, for a job the laptop's own worker holds: what the
 * local lane's preparation opens a leg or a run over, and what its task
 * broker serves the runner from — the same methods a Sandbox reaches over
 * HTTP, scoped to this one job (job-api/port.ts localJobPort).
 */
import type { TaskApiConfig } from "@shipbash/contracts/runtime/job-api.mjs";
import { createTaskBroker, type TaskBroker } from "@shipbash/runner/runtime/task-broker.mjs";

import type { JobApiResources } from "../job-api/define.ts";
import { type JobPort, localJobPort } from "../job-api/port.ts";
import type { DispatchExecutionInput, DispatchJobLeaseCapability } from "../types.ts";

export function localJobPortFor(
  resources: JobApiResources,
  capability: DispatchJobLeaseCapability,
  input: DispatchExecutionInput,
): JobPort {
  return localJobPort({
    ...resources,
    capability,
    job: {
      id: capability.jobId,
      kind: input.kind,
      teamId: input.job.teamId,
      projectId: input.job.projectId,
      activityId: input.kind === "activity" ? input.activity.id : null,
      suiteRunId: input.kind === "suite_run" ? input.suiteRunId : null,
    },
  });
}

/**
 * The task API the runner asks for a saved sign-in's fields and for the
 * record: a broker on the Docker host serving the job port, and the accounts
 * on offer. The caller closes the broker when the run ends.
 */
export async function openLocalTaskApi(port: JobPort, signal: AbortSignal): Promise<{ broker: TaskBroker; config: TaskApiConfig }> {
  const signIns = await port.credentialsList();
  const broker = await createTaskBroker({ source: port, host: "host.docker.internal", signal });
  return { broker, config: { ...broker.config, signIns } };
}
