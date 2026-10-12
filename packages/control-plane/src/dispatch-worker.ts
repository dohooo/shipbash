import { capabilityFrom, requiredText, safeFailure } from "./dispatch-worker-support.ts";
import { runActivityInDocker } from "./activity-runtime.ts";
import { runSuiteInDocker } from "./docker-runtime.ts";
import { isTransientInfrastructureFailure, TransientQueueTaskError } from "./transient-failure.ts";
import { executeSuite } from "./dispatch-worker-suite-execution.ts";
import { executeActivity } from "./dispatch-worker-activity-execution.ts";
import type {
  ActivityRunner,
  DispatchTask,
  DispatchWorkerOptions,
  DispatchWorkerOutcome,
  DispatchWorkerStore,
  RuntimeDisposition,
  SuiteRunner,
} from "./dispatch-worker-types.ts";
import type {
  ActivityExecutionInput,
  DispatchJobLeaseCapability,
  SuiteExecutionInput,
} from "./types.ts";

import { type ControlInboxFeed, createControlInboxFeed } from "./dispatch-worker-control-inbox.ts";

type ClaimedJob = NonNullable<Awaited<ReturnType<DispatchWorkerStore["claimDispatchJob"]>>>;

class DispatchLeaseLostError extends Error {
  constructor(cause: unknown) {
    super("Dispatch Job lease renewal failed.", { cause });
    this.name = "DispatchLeaseLostError";
  }
}

class LeaseHeartbeat {
  readonly controller = new AbortController();
  /** The Activity's control inbox on every renewal; the leg's watcher delivers what is new (dispatch-worker-control-inbox.ts). */
  readonly inbox = createControlInboxFeed();
  error: unknown = null;
  #timer: NodeJS.Timeout | null = null;
  #renewal: Promise<void> | null = null;
  #stopped = false;
  readonly #onExternalAbort: () => void;

  constructor(
    private readonly store: DispatchWorkerStore,
    private readonly capability: DispatchJobLeaseCapability,
    private readonly leaseSeconds: number,
    intervalMs: number,
    externalSignal: AbortSignal,
  ) {
    this.#onExternalAbort = () => this.controller.abort(externalSignal.reason);
    if (externalSignal.aborted) this.#onExternalAbort();
    else externalSignal.addEventListener("abort", this.#onExternalAbort, { once: true });
    this.#timer = setInterval(() => this.#renew(), intervalMs);
    this.#timer.unref();
  }

  #renew(): void {
    if (this.#stopped || this.#renewal) return;
    this.#renewal = this.store.heartbeatDispatchJob(this.capability, this.leaseSeconds)
      .then(({ cancelRequested, inbox }) => {
        if (inbox) this.inbox.publish(inbox);
        if (cancelRequested) this.controller.abort("cancel_requested");
      })
      .catch((error: unknown) => {
        this.error = error;
        this.controller.abort(error);
      })
      .finally(() => {
        this.#renewal = null;
      });
  }

  async stop(externalSignal: AbortSignal): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    externalSignal.removeEventListener("abort", this.#onExternalAbort);
    await this.#renewal;
  }
}

export class DispatchWorker {
  readonly #store: DispatchWorkerStore;
  readonly #workerId: string;
  readonly #prepareActivity: DispatchWorkerOptions["prepareActivity"];
  readonly #onOwnerTurn: DispatchWorkerOptions["onOwnerTurn"];
  readonly #workProgress: DispatchWorkerOptions["workProgress"];
  readonly #prepareSuite: DispatchWorkerOptions["prepareSuite"];
  readonly #recoverSuite: DispatchWorkerOptions["recoverSuite"];
  readonly #runSuite: SuiteRunner;
  readonly #runActivity: ActivityRunner;
  readonly #leaseSeconds: number;
  readonly #heartbeatIntervalMs: number;

  constructor(options: DispatchWorkerOptions) {
    this.#store = options.store;
    this.#workerId = requiredText(options.workerId, "workerId");
    this.#prepareActivity = options.prepareActivity;
    this.#onOwnerTurn = options.onOwnerTurn;
    this.#workProgress = options.workProgress;
    this.#prepareSuite = options.prepareSuite;
    this.#recoverSuite = options.recoverSuite;
    this.#runSuite = options.runSuite ?? runSuiteInDocker;
    this.#runActivity = options.runActivity ?? runActivityInDocker;
    this.#leaseSeconds = options.leaseSeconds ?? 120;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs
      ?? Math.min(2_000, Math.floor((this.#leaseSeconds * 1_000) / 3));
    if (!Number.isInteger(this.#leaseSeconds) || this.#leaseSeconds < 15 || this.#leaseSeconds > 3_600) {
      throw new Error("leaseSeconds must be an integer between 15 and 3600.");
    }
    if (!Number.isInteger(this.#heartbeatIntervalMs) || this.#heartbeatIntervalMs < 1_000) {
      throw new Error("heartbeatIntervalMs must be at least 1000.");
    }
    if (this.#heartbeatIntervalMs >= this.#leaseSeconds * 1_000) {
      throw new Error("heartbeatIntervalMs must be shorter than the Job lease.");
    }
  }

  async execute(task: DispatchTask, signal: AbortSignal): Promise<DispatchWorkerOutcome> {
    const job = await this.#store.claimDispatchJob(
      requiredText(task.jobId, "jobId"),
      requiredText(task.identityHash, "identityHash"),
      this.#workerId,
      this.#leaseSeconds,
    );
    if (!job) return "not_claimed";
    const work = job.suiteRunId ? { suiteRunId: job.suiteRunId } : job.activityId ? { activityId: job.activityId } : null;
    // Shown beside the job, not ahead of it; the job's end is shown after it.
    const started = work && this.#workProgress?.changed(work);
    try {
      return await this.#executeClaimed(task, job, signal);
    } finally {
      // However the leg ended, its owner may now be told what it said; however
      // the job ended, its work's progress is shown as it stands.
      if (job.kind === "activity" && job.activityId) await this.#onOwnerTurn?.(job.activityId);
      await started;
      if (work) await this.#workProgress?.settle(work);
    }
  }

  async #executeClaimed(task: DispatchTask, job: ClaimedJob, signal: AbortSignal): Promise<DispatchWorkerOutcome> {
    const capability = capabilityFrom(job, task.identityHash);
    const heartbeat = new LeaseHeartbeat(
      this.#store,
      capability,
      this.#leaseSeconds,
      this.#heartbeatIntervalMs,
      signal,
    );
    let disposition: RuntimeDisposition;
    try {
      if (await this.#store.isDispatchCancellationRequested(capability)) {
        await heartbeat.stop(signal);
        await this.#store.cancelDispatchJob(capability, "Canceled by user.");
        return "canceled";
      }
      const input = await this.#store.loadDispatchExecutionInput(capability);
      if (input.job.id !== job.id || input.job.teamId !== job.teamId || input.job.projectId !== job.projectId) {
        throw new Error("Dispatch execution input does not match the claimed Job scope.");
      }
      if (task.expectedKind && input.kind !== task.expectedKind) {
        throw new Error(`Dispatch Job kind is ${input.kind}, not ${task.expectedKind}.`);
      }
      disposition = input.kind === "suite_run"
        ? await this.#executeSuite(input, capability, heartbeat.controller)
        : await this.#executeActivity(input, capability, heartbeat.controller, heartbeat.inbox);
    } catch (error) {
      return await this.#handleExecuteFailure(task, capability, heartbeat, signal, error);
    }
    return await this.#finalizeDisposition(capability, heartbeat, signal, disposition);
  }

  async #handleExecuteFailure(
    task: DispatchTask,
    capability: DispatchJobLeaseCapability,
    heartbeat: LeaseHeartbeat,
    signal: AbortSignal,
    error: unknown,
  ): Promise<DispatchWorkerOutcome> {
    await heartbeat.stop(signal);
    if (heartbeat.error) throw new DispatchLeaseLostError(heartbeat.error);
    if (heartbeat.controller.signal.aborted && heartbeat.controller.signal.reason === "cancel_requested") {
      await this.#store.cancelDispatchJob(capability, "Canceled by user.");
      return "canceled";
    }
    if (task.retryTransientFailure && isTransientInfrastructureFailure(error)) {
      await this.#retryTransientFailure(task.retryTransientFailure, capability, error);
    }
    return await this.#terminalizeFailure(capability, signal, error);
  }

  async #retryTransientFailure(
    handBack: NonNullable<DispatchTask["retryTransientFailure"]>, capability: DispatchJobLeaseCapability, error: unknown,
  ): Promise<never> {
    const reason = safeFailure(error);
    try {
      await this.#store.appendRunEventForJob(capability, {
        caseRunId: null,
        type: "runner_retrying",
        level: "warning",
        message: "A transient infrastructure failure interrupted the Runner. Retrying automatically.",
        data: { detail: reason.slice(0, 500) },
      });
    } catch {
      // Retry visibility is best-effort (and unavailable for Activity Jobs);
      // failing to record the event must never block the retry itself.
    }
    try {
      await handBack(capability, reason);
    } catch (retryPreparationError) {
      throw new TransientQueueTaskError(
        "Could not durably prepare a transient Dispatch retry.",
        { cause: retryPreparationError },
      );
    }
    throw new TransientQueueTaskError(
      "Transient Dispatch infrastructure failure; retrying once.",
      { cause: error },
    );
  }

  async #finalizeDisposition(
    capability: DispatchJobLeaseCapability,
    heartbeat: LeaseHeartbeat,
    signal: AbortSignal,
    disposition: RuntimeDisposition,
  ): Promise<DispatchWorkerOutcome> {
    await heartbeat.stop(signal);
    if (heartbeat.error) throw new DispatchLeaseLostError(heartbeat.error);
    if ("finalizationFailure" in disposition && disposition.finalizationFailure) {
      await this.#store.markDispatchFinalizationFailed(
        capability,
        disposition.finalizationFailure,
      );
    }
    if (disposition.kind === "waiting_for_auth") {
      await this.#store.releaseDispatchJobWaitingForAuth(capability);
      return "waiting_for_auth";
    }
    if (disposition.kind === "canceled") {
      await this.#store.cancelDispatchJob(capability, disposition.reason);
      return "canceled";
    }
    if (disposition.kind === "failed") {
      await this.#store.failDispatchJob(capability, disposition.reason);
      return "failed";
    }
    if (disposition.kind === "activity_completed") {
      return await this.#completeActivity(capability, signal, disposition);
    }
    return await this.#completeSuiteRun(capability, signal, disposition);
  }

  async #completeActivity(
    capability: DispatchJobLeaseCapability,
    signal: AbortSignal,
    disposition: Extract<RuntimeDisposition, { kind: "activity_completed" }>,
  ): Promise<DispatchWorkerOutcome> {
    try {
      await this.#store.completeActivityForJob(capability, {
        status: disposition.status,
        resultKind: disposition.status === "completed"
          ? (disposition.proposalIds.length ? "proposals" : "no_changes")
          : "needs_attention",
        summary: disposition.summary,
        attentionCode: disposition.attentionCode,
        recoveryAction: disposition.recoveryAction,
        proposalIds: disposition.proposalIds,
      });
      return disposition.status === "completed" ? "completed" : "failed";
    } catch (error) {
      return await this.#terminalizeFailure(capability, signal, error);
    }
  }

  async #completeSuiteRun(
    capability: DispatchJobLeaseCapability,
    signal: AbortSignal,
    disposition: Extract<RuntimeDisposition, { kind: "completed" }>,
  ): Promise<DispatchWorkerOutcome> {
    try {
      const finalizationFailed = disposition.hookFailureReason
        ? await this.#store.completeDispatchJob(capability, disposition.hookFailureReason)
        : await this.#store.completeDispatchJob(capability);
      return finalizationFailed || disposition.finalizationFailure ? "failed" : "completed";
    } catch (error) {
      return await this.#terminalizeFailure(capability, signal, error);
    }
  }

  async #terminalizeFailure(
    capability: DispatchJobLeaseCapability,
    signal: AbortSignal,
    error: unknown,
  ): Promise<DispatchWorkerOutcome> {
    if (signal.aborted) {
      await this.#store.cancelDispatchJob(capability, "Canceled by the dispatch queue.");
      return "canceled";
    }
    const reason = safeFailure(error);
    await this.#store.failDispatchJob(capability, reason);
    return "failed";
  }

  #executeSuite(
    input: SuiteExecutionInput,
    capability: DispatchJobLeaseCapability,
    controller: AbortController,
  ): Promise<RuntimeDisposition> {
    return executeSuite(
      {
        store: this.#store,
        prepareSuite: this.#prepareSuite,
        recoverSuite: this.#recoverSuite,
        runSuite: this.#runSuite,
        workProgress: this.#workProgress,
      },
      input,
      capability,
      controller,
    );
  }

  #executeActivity(
    input: ActivityExecutionInput,
    capability: DispatchJobLeaseCapability,
    controller: AbortController,
    inbox: ControlInboxFeed,
  ): Promise<RuntimeDisposition> {
    return executeActivity(
      {
        store: this.#store,
        prepareActivity: this.#prepareActivity,
        runActivity: this.#runActivity,
        onOwnerTurn: this.#onOwnerTurn,
        workProgress: this.#workProgress,
      },
      input,
      capability,
      controller,
      inbox,
    );
  }
}
