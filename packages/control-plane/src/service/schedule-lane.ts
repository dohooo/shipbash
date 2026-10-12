/**
 * The schedule lane: pg-boss runs ONLY the schedule tick, and this module
 * is everything that tick touches.
 *
 * reconcileSchedules mirrors active Suite schedules into cron registrations
 * (signature-diffed so unchanged schedules cost nothing) and self-heals
 * overdue ones; scheduleTick is the queue-side worker. The reconciler is
 * single-flight — close() drains whatever is in flight via pending().
 */
import { createHash } from "node:crypto";

import type { GitHubTenantService } from "../github-tenant-service.ts";
import type { QueueTaskContext, ScheduleTickPayload, ShipBashJobQueue } from "../job-queue.ts";
import { isTransientInfrastructureFailure, TransientQueueTaskError } from "../transient-failure.ts";
import { modelContractFor } from "@shipbash/contracts/model-contract";
import { promptContractVersions } from "@shipbash/contracts/prompt-contracts";
import { scheduleCronExpression } from "../schedule-cron.ts";
import type { TenantStore } from "../store/tenant-store.ts";
import { scheduledDispatchExpiry } from "./scheduled-dispatch.ts";
import { claimOverdueSchedules } from "./schedule-self-heal.ts";

type QueueWorkHandlers = Parameters<ShipBashJobQueue["work"]>[0];

/**
 * The lane holds a nullable store because the service can boot without one,
 * but the queue that drives scheduleTick is only started alongside a dispatch
 * worker, and a dispatch worker is only built when a store exists. A tick with
 * no store therefore means the lane was driven out of band, and the occurrence
 * must fail rather than be silently dropped.
 */
function requireTenantStore(tenantStore: TenantStore | null): TenantStore {
  if (!tenantStore) throw new Error("The schedule tick has no tenant store.");
  return tenantStore;
}

/** What the schedule lane borrows from the service closure. */
export interface ScheduleLaneContext {
  jobQueue: ShipBashJobQueue | null;
  tenantStore: TenantStore | null;
  github: GitHubTenantService | undefined;
  reconcileDispatchQueue(): Promise<void>;
}

export interface ScheduleLane {
  reconcileSchedules(): Promise<void>;
  scheduleTick: QueueWorkHandlers["scheduleTick"];
  /** In-flight reconciliations close() must let settle before stopping. */
  pending(): Promise<void>[];
}

/**
 * One reconciliation pass: mirror active Suite schedules into cron
 * registrations, drop registrations nothing wants any more, then claim
 * whatever the queue's cron supervision let go overdue. The signature map is
 * the diff — an unchanged schedule costs no queue call at all.
 */
async function runScheduleReconcile(input: {
  jobQueue: ShipBashJobQueue;
  tenantStore: TenantStore;
  scheduleSignatures: Map<string, string>;
  reconcileDispatchQueue(): Promise<void>;
}): Promise<void> {
  const { jobQueue, tenantStore, scheduleSignatures, reconcileDispatchQueue } = input;
  const schedules = await tenantStore.internal.listActiveSuiteSchedulesInternal();
  const desired = new Set<string>();
  for (const schedule of schedules) {
    const expression = scheduleCronExpression(schedule);
    if (!expression || !schedule.timezone) continue;
    const key = `suite/${schedule.id}`;
    desired.add(key);
    const signature = `${expression}\0${schedule.timezone}`;
    if (scheduleSignatures.get(key) === signature) continue;
    await jobQueue.setCronSchedule(
      key,
      expression,
      schedule.timezone,
      {
        scheduleId: schedule.id,
        projectId: schedule.projectId,
        teamId: schedule.teamId,
        inputVersion: 1,
      },
    );
    scheduleSignatures.set(key, signature);
  }
  const registered = await jobQueue.listScheduleKeys();
  for (const key of registered) {
    if (desired.has(key)) continue;
    await jobQueue.disableSchedule(key);
    scheduleSignatures.delete(key);
  }
  const overdue = await claimOverdueSchedules({ tenantStore: tenantStore.internal });
  if (overdue > 0) await reconcileDispatchQueue();
}

/** The tick: persist the occurrence, then wake the queue. */
async function runSuiteTick(input: {
  tenantStore: TenantStore | null;
  payload: ScheduleTickPayload;
  jobId: string;
  scheduledFor: string;
  queueContext: QueueTaskContext;
  reconcileDispatchQueue(): Promise<void>;
}): Promise<void> {
  const { tenantStore, payload, jobId, scheduledFor, queueContext, reconcileDispatchQueue } = input;
  try {
    await requireTenantStore(tenantStore).internal.dispatchScheduledRunInternal(
      payload.scheduleId,
      scheduledFor,
      {
        identityHash: createHash("sha256")
          .update(`schedule-job\0${jobId}`, "utf8")
          .digest("hex"),
        expiresAt: scheduledDispatchExpiry(Date.now()),
        promptContractVersions: promptContractVersions(),
        modelContract: modelContractFor("verification"),
      },
      jobId,
    );
  } catch (error) {
    if (queueContext.canRetryTransientFailure && isTransientInfrastructureFailure(error)) {
      throw new TransientQueueTaskError(
        "Suite Schedule persistence was temporarily unavailable.",
        { cause: error },
      );
    }
    throw error;
  }
  await reconcileDispatchQueue();
}

export function createScheduleLane(context: ScheduleLaneContext): ScheduleLane {
  const { jobQueue, tenantStore, github, reconcileDispatchQueue } = context;

  let scheduleReconcileInFlight: Promise<void> | null = null;
  let repositoryReadInFlight: Promise<void> | null = null;
  const scheduleSignatures = new Map<string, string>();

  const reconcileSchedules = async (): Promise<void> => {
    if (!jobQueue || !tenantStore) return;
    if (scheduleReconcileInFlight) return scheduleReconcileInFlight;
    scheduleReconcileInFlight = runScheduleReconcile({
      jobQueue, tenantStore, scheduleSignatures, reconcileDispatchQueue,
    }).finally(() => {
      scheduleReconcileInFlight = null;
    });
    // The bound repositories' reads ride the same tick but never hold it:
    // nothing waits on GitHub, boot included.
    readStaleRepositories();
    return scheduleReconcileInFlight;
  };

  /** One pass over the stale bindings at a time, fired and forgotten. */
  const readStaleRepositories = (): void => {
    if (!github || repositoryReadInFlight) return;
    repositoryReadInFlight = github.readStaleRepositories()
      .then(() => undefined, () => undefined)
      .finally(() => {
        repositoryReadInFlight = null;
      });
  };

  const scheduleTick: QueueWorkHandlers["scheduleTick"] = async (payload, jobId, signal, queueContext) => {
    if (signal.aborted) return;
    await runSuiteTick({
      tenantStore, payload, jobId, scheduledFor: queueContext.createdAt, queueContext, reconcileDispatchQueue,
    });
  };

  return {
    reconcileSchedules,
    scheduleTick,
    pending: () => (scheduleReconcileInFlight ? [scheduleReconcileInFlight] : []),
  };
}
