/**
 * The live edges of a running Activity container: its NDJSON event stream, the
 * stderr its leg log keeps, and the cancellation wiring that stops it.
 */
import { StringDecoder } from "node:string_decoder";

import {
  recordContainerStderrLine,
  resolvePublishedPort,
  runCapture,
  writeActivityCancelSentinel,
  writeActivityRuntimeDiagnostic,
  type ActivityLegLog,
} from "./container.ts";
import { ActivityNdjsonParser, type ActivityRuntimeEvent } from "./events.ts";
import { redactString } from "./redaction.ts";

/** The host-side transitions worth a diagnostic line when the runner reports them. */
const RUNNER_TRANSITION_EVENTS = new Set([
  "human_auth_ready",
  "human_auth_completed",
  "human_auth_resumed",
  "activity_result_prepared",
]);

function writeRunnerTransition(event: ActivityRuntimeEvent, activityId: string, containerName: string): void {
  if (typeof event.safeData.event !== "string" || !RUNNER_TRANSITION_EVENTS.has(event.safeData.event)) return;
  writeActivityRuntimeDiagnostic("runner_transition", {
    activityId,
    containerName,
    sequence: event.sequence,
    transition: event.safeData.event,
    status: typeof event.safeData.status === "string" ? event.safeData.status : null,
  });
}

interface ActivityEventPump {
  push: (chunk: Buffer) => void;
  finish: () => void;
  drain: () => Promise<void>;
  failure: () => Error | null;
  lastSequence: () => number;
}

/** Owns the NDJSON parser and the serialized delivery queue behind it. */
export function createActivityEventPump(context: {
  activityId: string;
  containerName: string;
  controlDirectory: string;
  dockerBinary: string;
  sensitiveValues: string[];
  onEvent: (event: ActivityRuntimeEvent) => void | Promise<void>;
}): ActivityEventPump {
  const { activityId, containerName, controlDirectory, dockerBinary, onEvent } = context;
  const parser = new ActivityNdjsonParser(context.sensitiveValues);
  let parseError: Error | null = null;
  let eventQueue = Promise.resolve();
  let lastSequence = 0;
  const dispatch = (event: ActivityRuntimeEvent): void => {
    if (event.activityId !== activityId) {
      parseError ??= new Error("Activity runtime emitted an event for another Activity.");
      return;
    }
    if (event.sequence <= lastSequence) {
      parseError ??= new Error("Activity runtime event sequence is not monotonic.");
      return;
    }
    lastSequence = event.sequence;
    eventQueue = eventQueue.then(async () => {
      let delivered = event;
      if (event.kind === "evidence" && event.safeData.event === "browser_stream_ready") {
        delivered = {
          ...event,
          safeData: {
            ...event.safeData,
            host: "127.0.0.1",
            hostPort: await resolvePublishedPort(dockerBinary, containerName, 9224),
            protocol: "ws",
          },
        };
      }
      writeRunnerTransition(delivered, activityId, containerName);
      await onEvent(delivered);
    });
  };

  return {
    push(chunk: Buffer): void {
      if (parseError) return;
      try { for (const event of parser.push(chunk)) dispatch(event); }
      catch (error) {
        parseError = error instanceof Error ? error : new Error(String(error));
        void writeActivityCancelSentinel(controlDirectory);
      }
    },
    finish(): void {
      try { for (const event of parser.finish()) dispatch(event); }
      catch (error) { parseError ??= error instanceof Error ? error : new Error(String(error)); }
    },
    drain: () => eventQueue,
    failure: () => parseError,
    lastSequence: () => lastSequence,
  };
}

/** Buffers container stderr into whole lines for the leg log and the host. */
export function createActivityStderrRecorder(context: {
  sensitiveValues: string[];
  launchStderr: string[];
  legLog: ActivityLegLog;
}): { push: (chunk: Buffer) => void; flush: () => void } {
  const { launchStderr, legLog, sensitiveValues } = context;
  const stderrDecoder = new StringDecoder("utf8");
  let stderrBuffer = "";
  return {
    push(chunk: Buffer): void {
      stderrBuffer += stderrDecoder.write(chunk);
      const lines = stderrBuffer.split(/\r?\n/u);
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) recordContainerStderrLine(line, sensitiveValues, launchStderr, legLog);
    },
    flush(): void {
      stderrBuffer += stderrDecoder.end();
      if (stderrBuffer) process.stderr.write(redactString(stderrBuffer, sensitiveValues));
    },
  };
}

/** Wires cancellation to the sentinel and the forced stop; returns the detach. */
export function attachActivityAbortWiring(context: {
  signal: AbortSignal;
  dockerBinary: string;
  containerName: string;
  controlDirectory: string;
  onAbortRequested: () => void;
}): () => void {
  const { containerName, controlDirectory, dockerBinary, signal } = context;
  let forceTimer: NodeJS.Timeout | undefined;
  const abort = (): void => {
    context.onAbortRequested();
    void writeActivityCancelSentinel(controlDirectory);
    forceTimer = setTimeout(() => { void runCapture(dockerBinary, ["stop", "--time", "5", containerName]).catch(() => undefined); }, 10_000);
    forceTimer.unref();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return () => {
    signal.removeEventListener("abort", abort);
    if (forceTimer) clearTimeout(forceTimer);
  };
}
