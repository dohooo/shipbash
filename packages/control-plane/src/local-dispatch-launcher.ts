import { setTimeout as delay } from "node:timers/promises";

import { TransientQueueTaskError } from "./transient-failure.ts";
import type {
  DispatchTask,
  DispatchWorkerOutcome,
} from "./dispatch-worker-types.ts";

export interface PendingDispatchTask {
  jobId: string;
  identityHash: string;
  kind: "suite_run" | "activity";
  projectId: string;
  /** A conversation's turn: run on the host, outside the project's one Activity slot. */
  host: boolean;
}

export interface LocalDispatchLauncherOptions {
  listTasks(limit: number): Promise<PendingDispatchTask[]>;
  reconcileExpiredCancellations(limit: number): Promise<number>;
  /**
   * Work that must not hold a launch up — the Slack alert sweep — run once
   * the queued tasks of a drain have been launched.
   */
  afterLaunch?(): Promise<unknown>;
  /** Runs one claimed task; `host` says it is a conversation's turn, run in this process. */
  execute(task: DispatchTask, signal: AbortSignal, host: boolean): Promise<DispatchWorkerOutcome>;
  /** Readies a job a transient failure interrupted for its one more run (store/dispatch-lifecycle.ts). */
  prepareTransientRetry: NonNullable<DispatchTask["retryTransientFailure"]>;
  suiteConcurrency?: number;
  activityConcurrency?: number;
  recoveryIntervalMs?: number;
  transientRetryDelayMs?: number;
  onError?: (error: unknown, task?: PendingDispatchTask) => void;
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return resolved;
}

/**
 * Lightweight local control-plane launcher. It owns no browser, Agent, or
 * Runner process while idle; each claimed task delegates to the existing
 * one-shot Docker runtime and releases its slot when that runtime exits.
 */
export class LocalDispatchLauncher {
  readonly #options: LocalDispatchLauncherOptions;
  readonly #suiteConcurrency: number;
  readonly #activityConcurrency: number;
  readonly #recoveryIntervalMs: number;
  readonly #transientRetryDelayMs: number;
  readonly #active = new Map<string, {
    controller: AbortController;
    promise: Promise<void>;
    task: PendingDispatchTask;
  }>();
  readonly #activeActivityProjects = new Set<string>();
  #closed = false;
  #draining: Promise<void> | null = null;
  #wakeRequested = false;
  #recoveryTimer: NodeJS.Timeout | null = null;

  constructor(options: LocalDispatchLauncherOptions) {
    this.#options = options;
    this.#suiteConcurrency = positiveInteger(options.suiteConcurrency, 2, "suiteConcurrency");
    this.#activityConcurrency = positiveInteger(options.activityConcurrency, 2, "activityConcurrency");
    this.#recoveryIntervalMs = nonNegativeInteger(
      options.recoveryIntervalMs,
      30_000,
      "recoveryIntervalMs",
    );
    this.#transientRetryDelayMs = nonNegativeInteger(
      options.transientRetryDelayMs,
      5_000,
      "transientRetryDelayMs",
    );
  }

  get activeTaskCount(): number {
    return this.#active.size;
  }

  start(): void {
    if (this.#closed || this.#recoveryTimer || this.#recoveryIntervalMs === 0) return;
    this.#recoveryTimer = setInterval(() => {
      void this.wake();
    }, this.#recoveryIntervalMs);
    this.#recoveryTimer.unref();
  }

  wake(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#wakeRequested = true;
    this.#draining ??= this.#drain().finally(() => {
      this.#draining = null;
      if (this.#wakeRequested && !this.#closed) void this.wake();
    });
    return this.#draining;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#recoveryTimer) clearInterval(this.#recoveryTimer);
    this.#recoveryTimer = null;
    for (const active of this.#active.values()) active.controller.abort("launcher_closed");
    await Promise.allSettled([
      ...(this.#draining ? [this.#draining] : []),
      ...[...this.#active.values()].map((entry) => entry.promise),
    ]);
  }

  async #drain(): Promise<void> {
    while (!this.#closed) {
      this.#wakeRequested = false;
      try {
        await this.#options.reconcileExpiredCancellations(100);
        const pending = await this.#options.listTasks(100);
        let launched = false;
        for (const task of pending) {
          if (!this.#canLaunch(task)) continue;
          this.#launch(task);
          launched = true;
        }
        await this.#options.afterLaunch?.();
        if (!launched || !this.#wakeRequested) return;
      } catch (error) {
        this.#options.onError?.(error);
        return;
      }
    }
  }

  #canLaunch(task: PendingDispatchTask): boolean {
    if (this.#active.has(task.jobId)) return false;
    // A conversation's turn takes no container and no browser state: it waits for none.
    if (task.host) return true;
    const activeOfKind = [...this.#active.values()].filter((entry) => entry.task.kind === task.kind && !entry.task.host).length;
    if (task.kind === "suite_run") return activeOfKind < this.#suiteConcurrency;
    return activeOfKind < this.#activityConcurrency && !this.#activeActivityProjects.has(task.projectId);
  }

  #launch(task: PendingDispatchTask): void {
    const controller = new AbortController();
    const holdsSlot = task.kind === "activity" && !task.host;
    if (holdsSlot) this.#activeActivityProjects.add(task.projectId);
    const promise = this.#executeWithSingleTransientRetry(task, controller.signal)
      .catch((error: unknown) => this.#options.onError?.(error, task))
      .finally(() => {
        this.#active.delete(task.jobId);
        if (holdsSlot) this.#activeActivityProjects.delete(task.projectId);
        if (!this.#closed) void this.wake();
      });
    this.#active.set(task.jobId, { controller, promise, task });
  }

  async #executeWithSingleTransientRetry(
    task: PendingDispatchTask,
    signal: AbortSignal,
  ): Promise<void> {
    // A conversation's turn is never retried: a dead one's lease expires,
    // and the next turn answers what it left owed.
    const dispatch: DispatchTask = {
      jobId: task.jobId,
      identityHash: task.identityHash,
      expectedKind: task.kind,
    };
    try {
      await this.#options.execute(
        task.host ? dispatch : { ...dispatch, retryTransientFailure: this.#options.prepareTransientRetry },
        signal,
        task.host,
      );
      return;
    } catch (error) {
      if (!(error instanceof TransientQueueTaskError) || signal.aborted) throw error;
    }
    if (this.#transientRetryDelayMs > 0) {
      await delay(this.#transientRetryDelayMs, undefined, { signal, ref: false }).catch(() => {});
    }
    if (signal.aborted) return;
    await this.#options.execute(dispatch, signal, task.host);
  }
}
