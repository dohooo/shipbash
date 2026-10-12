import {
  PgBoss,
  type JobWithMetadata,
  type Schedule,
  type ScheduleOptions,
  type WorkOptions,
} from "pg-boss";

import { assertIanaTimezone } from "./schedule-cron.ts";
import { errorCode, isTransientInfrastructureFailure, TransientQueueTaskError } from "./transient-failure.ts";

export const SCHEDULE_TICK_QUEUE = "shipbash-schedule-ticks";

// Suite runs and Activities are executed by the dispatch_jobs table, not by
// pg-boss, which only fires the Suite schedules' ticks.
export interface ScheduleTickPayload {
  scheduleId: string;
  projectId: string;
  teamId: string;
  inputVersion: number;
}

interface QueueDriver {
  start(): Promise<unknown>;
  stop(options?: { graceful?: boolean; timeout?: number; close?: boolean }): Promise<void>;
  createQueue(name: string, options?: Record<string, unknown>): Promise<void>;
  work<T>(
    name: string,
    options: WorkOptions,
    handler: (jobs: JobWithMetadata<T>[]) => Promise<unknown>,
  ): Promise<string>;
  schedule(name: string, cron: string, data?: object | null, options?: ScheduleOptions): Promise<void>;
  unschedule(name: string, key?: string): Promise<void>;
  getSchedules(): Promise<Schedule[]>;
  // pg-boss is an EventEmitter; ShipBashJobQueue listens for its 'error' event.
  on(event: "error", handler: (error: unknown) => void): void;
}

// pg-boss's published types do not line up with the narrow surface this
// queue drives, so the driver is recognised by the methods it must carry
// instead of being asserted into place.
function isQueueDriver(value: object): value is QueueDriver {
  return (
    "start" in value &&
    "stop" in value &&
    "createQueue" in value &&
    "work" in value &&
    "schedule" in value &&
    "unschedule" in value &&
    "getSchedules" in value &&
    "on" in value
  );
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

const QUEUE_LOG_PREFIX = "[shipbash-background-queue]";
const QUEUE_ERROR_MESSAGE_LIMIT = 500;
const TRANSIENT_QUEUE_NOTE =
  "The database connection dropped; the queue reconnects on its own and jobs resume once it is reachable.";
const PERSISTENT_QUEUE_NOTE =
  "This is not a dropped connection; the background queue will not recover until the service is restarted.";

/** Reduces any embedded connection string so no credential rides a log line. */
function redactConnectionStrings(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/\S+/giu, "postgres://[redacted]");
}

/**
 * The human-readable message off a pg-boss 'error' payload. pg-boss emits a
 * real Error on some paths (the pool, the timekeeper) but a plain object spread
 * — `{ ...error, message, stack, queue, worker }` — on its busiest one, the
 * worker poll (manager.js), so reading `message` only off Error instances would
 * log "[object Object]" for the very path that fails on a database blip.
 */
function messageOf(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

/**
 * The structured record a pg-boss 'error' event is logged as: the ISO time, the
 * error's own code and message (bounded, connection string redacted), and a
 * note that tells the truth about recovery. A dropped connection heals on its
 * own; anything else (a dropped schema, a rotated password, a revoked grant)
 * leaves the schedule lane broken until a restart re-runs pg-boss's setup, so
 * the note must not promise a recovery that will not come.
 */
export function describeQueueError(error: unknown): {
  timestamp: string;
  event: "queue_connection_error";
  code: string | null;
  message: string;
  note: string;
} {
  return {
    timestamp: new Date().toISOString(),
    event: "queue_connection_error",
    code: errorCode(error),
    message: redactConnectionStrings(messageOf(error)).slice(0, QUEUE_ERROR_MESSAGE_LIMIT),
    note: isTransientInfrastructureFailure(error) ? TRANSIENT_QUEUE_NOTE : PERSISTENT_QUEUE_NOTE,
  };
}

/**
 * One loud, structured stderr line per queue error, visible straight in the
 * dev-stack log. The listener's whole job is to never throw — an unhandled
 * throw here is the crash it exists to prevent — so a payload that cannot be
 * described still logs, minimally, rather than taking the process down.
 */
function logQueueError(error: unknown): void {
  try {
    process.stderr.write(`${QUEUE_LOG_PREFIX} ${JSON.stringify(describeQueueError(error))}\n`);
  } catch {
    process.stderr.write(`${QUEUE_LOG_PREFIX} {"event":"queue_connection_error","message":"unserializable queue error"}\n`);
  }
}

export interface QueueTaskContext {
  retryCount: number;
  retryLimit: number;
  canRetryTransientFailure: boolean;
  createdAt: string;
}

function taskContext(job: JobWithMetadata<unknown>): QueueTaskContext {
  return {
    retryCount: job.retryCount,
    retryLimit: job.retryLimit,
    canRetryTransientFailure: job.retryCount < job.retryLimit,
    createdAt: job.createdOn.toISOString(),
  };
}

async function settleTask<T>(
  job: JobWithMetadata<T>,
  operation: (context: QueueTaskContext) => Promise<void>,
): Promise<void> {
  try {
    await operation(taskContext(job));
  } catch (error) {
    // PgBoss retries only explicitly classified infrastructure failures. Domain,
    // validation, and Agent-result failures settle once and remain durable in ShipBash.
    if (error instanceof TransientQueueTaskError && job.retryCount < job.retryLimit) throw error;
  }
}

export interface QueueWorkerHandlers {
  scheduleTick?: ((
    payload: ScheduleTickPayload,
    jobId: string,
    signal: AbortSignal,
    context: QueueTaskContext,
  ) => Promise<void>) | undefined;
}

export class ShipBashJobQueue {
  private started = false;

  constructor(private readonly driver: QueueDriver) {
    // pg-boss re-emits its connection pool's failures as an 'error' event, and
    // Node throws on an unhandled 'error' — one transient database blip (a local
    // Supabase container restart) would otherwise take the whole service down.
    // The listener keeps the process alive and loud: pg-boss reconnects and
    // resumes polling on its own. It is registered for the queue's entire life
    // and never removed on stop(), so a late error arriving after stop is still
    // swallowed rather than left to crash a shutting-down process.
    this.driver.on("error", logQueueError);
  }

  static forPostgres(connectionString: string): ShipBashJobQueue {
    const boss = new PgBoss({
      connectionString,
      schema: "shipbash_jobs",
      application_name: "shipbash-background-queue",
      schedule: true,
      migrate: true,
      createSchema: true,
      useListenNotify: true,
    });
    if (!isQueueDriver(boss)) {
      throw new Error("pg-boss does not implement the background queue driver.");
    }
    return new ShipBashJobQueue(boss);
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.driver.start();
    await this.driver.createQueue(SCHEDULE_TICK_QUEUE, {
      policy: "standard",
      retryLimit: 1,
      retryDelay: 30,
      retryBackoff: true,
      heartbeatSeconds: 30,
      expireInSeconds: 600,
      deleteAfterSeconds: 2_592_000,
      notify: true,
    });
    this.started = true;
  }

  async stop(timeout = 30_000): Promise<void> {
    if (!this.started) return;
    await this.driver.stop({ graceful: true, timeout, close: true });
    this.started = false;
  }

  async work(handlers: QueueWorkerHandlers): Promise<void> {
    if (!this.started) throw new Error("ShipBash job queue is not started.");
    const scheduleTick = handlers.scheduleTick;
    if (!scheduleTick) return;
    await this.driver.work<ScheduleTickPayload>(
      SCHEDULE_TICK_QUEUE,
      {
        localConcurrency: 1,
        batchSize: 1,
        pollingIntervalSeconds: 1,
        notifyPollingIntervalSeconds: 1,
        includeMetadata: true,
      },
      async ([job]) => {
        if (!job) return;
        await settleTask(
          job,
          (context) => scheduleTick(job.data, job.id, job.signal, context),
        );
      },
    );
  }

  async setCronSchedule(
    scheduleId: string,
    cronExpression: string,
    timezone: string,
    payload: ScheduleTickPayload,
  ): Promise<void> {
    if (!this.started) throw new Error("ShipBash job queue is not started.");
    const key = nonEmpty(scheduleId, "scheduleId");
    await this.driver.schedule(SCHEDULE_TICK_QUEUE, nonEmpty(cronExpression, "cronExpression"), {
      scheduleId: nonEmpty(payload.scheduleId, "scheduleId"),
      projectId: nonEmpty(payload.projectId, "projectId"),
      teamId: nonEmpty(payload.teamId, "teamId"),
      inputVersion: payload.inputVersion,
    }, {
      key,
      tz: assertIanaTimezone(timezone),
      singletonKey: key,
    });
  }

  async disableSchedule(scheduleId: string): Promise<void> {
    if (!this.started) throw new Error("ShipBash job queue is not started.");
    await this.driver.unschedule(SCHEDULE_TICK_QUEUE, nonEmpty(scheduleId, "scheduleId"));
  }

  async listScheduleKeys(): Promise<string[]> {
    if (!this.started) throw new Error("ShipBash job queue is not started.");
    const schedules = await this.driver.getSchedules();
    return schedules
      .filter((schedule) => schedule.name === SCHEDULE_TICK_QUEUE)
      .map((schedule) => schedule.key)
      .filter((key) => key.startsWith("suite/"));
  }
}
