/**
 * The live edges of a running Suite container: its event stream, its stderr,
 * and the cancellation wiring that stops it.
 */
import { StringDecoder } from "node:string_decoder";

import { NdjsonEventParser, type DockerRuntimeEvent } from "./events.ts";
import {
  resolvePublishedStreamPort,
  stopContainer,
  writeCancelSentinel,
} from "./reconcile.ts";
import { redactRuntimeStderr } from "./redaction.ts";

interface SuiteEventPump {
  push: (chunk: Buffer) => void;
  finish: () => void;
  drain: () => Promise<void>;
  suppressCancelEvents: () => void;
  failure: () => Error | null;
  lastEventType: () => string | undefined;
}

/** Owns the NDJSON parser and the serialized delivery queue behind it. */
export function createSuiteEventPump(context: {
  dockerBinary: string;
  containerName: string;
  controlDirectory: string;
  encryptionKey: string;
  sensitiveValues: string[];
  onEvent: (event: DockerRuntimeEvent) => void | Promise<void>;
  isAbortRequested: () => boolean;
}): SuiteEventPump {
  const { containerName, controlDirectory, dockerBinary, encryptionKey, onEvent } = context;
  const parser = new NdjsonEventParser(context.sensitiveValues);
  let lastEventType: string | undefined;
  let parseError: Error | null = null;
  let eventQueue = Promise.resolve();
  let internalStopRequested = false;

  const dispatch = (event: DockerRuntimeEvent): void => {
    if (internalStopRequested && !context.isAbortRequested() && event.type === "suite_canceled") return;
    lastEventType = event.type;
    eventQueue = eventQueue.then(async () => {
      // One bad event must never become an unhandled rejection that kills the
      // Runner process; log it and keep consuming the remaining events.
      try {
        let delivered = event;
        if (event.type === "browser_stream_ready") {
          const hostPort = await resolvePublishedStreamPort(dockerBinary, containerName);
          delivered = {
            ...event,
            host: "127.0.0.1",
            hostPort,
            protocol: "ws",
          };
        }
        await onEvent(delivered);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[${containerName}] Runtime event ${event.type} failed: ${redactRuntimeStderr(message, encryptionKey)}\n`,
        );
      }
    });
  };

  return {
    push(chunk: Buffer): void {
      if (parseError) {
        return;
      }
      try {
        for (const event of parser.push(chunk)) {
          dispatch(event);
        }
      } catch (error) {
        parseError = error instanceof Error ? error : new Error(String(error));
        void writeCancelSentinel(controlDirectory);
      }
    },
    finish(): void {
      try {
        for (const event of parser.finish()) {
          dispatch(event);
        }
      } catch (error) {
        parseError ??= error instanceof Error ? error : new Error(String(error));
      }
    },
    drain: () => eventQueue,
    suppressCancelEvents: () => {
      internalStopRequested = true;
    },
    failure: () => parseError,
    lastEventType: () => lastEventType,
  };
}

/** Buffers container stderr into whole lines and redacts each one. */
export function createStderrSink(
  encryptionKey: string,
  sensitiveValues: string[],
): { push: (chunk: Buffer) => void; flush: () => void } {
  const stderrDecoder = new StringDecoder("utf8");
  let stderrBuffered = "";
  return {
    push(chunk: Buffer): void {
      stderrBuffered += stderrDecoder.write(chunk);
      const lines = stderrBuffered.split(/\r?\n/);
      stderrBuffered = lines.pop() ?? "";
      for (const line of lines) {
        process.stderr.write(`${redactRuntimeStderr(line, encryptionKey, sensitiveValues)}\n`);
      }
    },
    flush(): void {
      stderrBuffered += stderrDecoder.end();
      if (stderrBuffered) {
        process.stderr.write(redactRuntimeStderr(stderrBuffered, encryptionKey, sensitiveValues));
        stderrBuffered = "";
      }
    },
  };
}

/** Wires cancellation to the sentinel and the forced stop; returns the detach. */
export function attachSuiteAbortWiring(context: {
  signal: AbortSignal;
  dockerBinary: string;
  containerName: string;
  controlDirectory: string;
  alreadyRequested: boolean;
  onAbortRequested: () => void;
}): () => void {
  const { containerName, controlDirectory, dockerBinary, signal } = context;
  let forcedStopTimer: NodeJS.Timeout | undefined;
  const onAbort = (): void => {
    context.onAbortRequested();
    void writeCancelSentinel(controlDirectory);
    forcedStopTimer = setTimeout(() => {
      void stopContainer(dockerBinary, containerName);
    }, 10_000);
    forcedStopTimer.unref();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted && !context.alreadyRequested) {
    onAbort();
  }
  return () => {
    signal.removeEventListener("abort", onAbort);
    if (forcedStopTimer) {
      clearTimeout(forcedStopTimer);
    }
  };
}
