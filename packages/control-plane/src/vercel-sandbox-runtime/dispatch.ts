import { StringDecoder } from "node:string_decoder";

import { redactRuntimeStderr, writeCancelSentinel } from "../docker-runtime.ts";
import { releaseTrustedAccessFileWhenConsumed } from "../trusted-access-runtime.ts";
import { childEnvironment } from "./child-environment.ts";
import type { SandboxRuntimeContext } from "./configuration.ts";
import type { RuntimeLayout } from "./paths.ts";

interface StderrTail {
  write(chunk: Buffer): void;
  end(): void;
  tail(): string;
}

/**
 * Bounded tail of the child's redacted stderr: when the runner dies without a
 * structured result, its dying words are the only diagnosis we get. Redacted
 * as both Docker lanes redact theirs (docker-runtime/stream.ts): the task's
 * own secrets by value, then the patterns.
 */
function createStderrTail(
  onStderr: (line: string) => void,
  encryptionKey: string,
  sensitiveValues: readonly string[],
): StderrTail {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const lines: string[] = [];
  const deliver = (line: string): void => {
    const redacted = redactRuntimeStderr(line, encryptionKey, sensitiveValues);
    if (redacted.trim()) {
      lines.push(redacted.slice(0, 400));
      if (lines.length > 12) lines.shift();
    }
    onStderr(redacted);
  };
  return {
    write(chunk: Buffer): void {
      buffer += decoder.write(chunk);
      const chunkLines = buffer.split(/\r?\n/u);
      buffer = chunkLines.pop() ?? "";
      for (const line of chunkLines) deliver(line);
    },
    end(): void {
      buffer += decoder.end();
      if (buffer) deliver(buffer);
    },
    tail(): string {
      return lines.join("\n");
    },
  };
}

/** What one run hands the child beyond the runtime context and its task layout. */
export interface DispatchSpec<TEvent> {
  script: string;
  encryptionKey: string;
  humanAuthPassword: string;
  inputPath: string;
  /** The checkout an Activity leg mounts; a suite run mounts none. */
  repositoryRoot?: string;
  trustedAccessWritten: boolean;
  /** The values this run's stderr must never carry: the human-auth password and the Trusted Access header. */
  sensitiveValues: readonly string[];
  signal: AbortSignal;
  parser: {
    push(chunk: Buffer | string): TEvent[];
    finish(): TEvent[];
  };
  onEvent(event: TEvent): void | Promise<void>;
}

export async function dispatchProcess<TEvent>(
  context: SandboxRuntimeContext,
  layout: RuntimeLayout,
  input: DispatchSpec<TEvent>,
): Promise<{
  exitCode: number | null;
  aborted: boolean;
  lastEvent: TEvent | undefined;
  stderrTail: string;
}> {
  const environment = childEnvironment(
    context.environment ?? process.env,
    layout,
    input.encryptionKey,
    input.humanAuthPassword,
    input.inputPath,
    input.repositoryRoot,
  );
  let aborted = input.signal.aborted;
  if (aborted) await writeCancelSentinel(layout.controlDirectory);
  const child = context.spawnProcess(context.nodeBinary, [input.script], {
    cwd: layout.workDirectory,
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    uid: context.childUid,
    gid: context.childGid,
  });
  let spawnError: Error | null = null;
  child.once("error", (error) => { spawnError = error; });
  const closed = new Promise<number | null>((resolvePromise) => {
    child.once("close", resolvePromise);
  });
  const trustedAccessRelease = input.trustedAccessWritten
    ? releaseTrustedAccessFileWhenConsumed({
        controlDirectory: layout.controlDirectory,
        trustedAccessDirectory: layout.trustedAccessDirectory,
        containerClosed: closed,
      })
    : Promise.resolve("container_closed" as const);
  let parseError: Error | null = null;
  let eventError: unknown;
  let eventQueue = Promise.resolve();
  let lastEvent: TEvent | undefined;
  const enqueue = (event: TEvent): void => {
    lastEvent = event;
    eventQueue = eventQueue.then(() => input.onEvent(event));
  };
  child.stdout.on("data", (chunk: Buffer) => {
    if (parseError) return;
    try {
      for (const event of input.parser.push(chunk)) enqueue(event);
    } catch (error) {
      parseError = error instanceof Error ? error : new Error(String(error));
      void writeCancelSentinel(layout.controlDirectory);
    }
  });
  const stderr = createStderrTail(context.onStderr, input.encryptionKey, input.sensitiveValues);
  child.stderr.on("data", (chunk: Buffer) => { stderr.write(chunk); });
  let killTimer: NodeJS.Timeout | undefined;
  const abort = (): void => {
    aborted = true;
    void writeCancelSentinel(layout.controlDirectory);
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), context.forceKillAfterMs);
    killTimer.unref();
  };
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted && !aborted) abort();

  const exitCode = await closed;
  input.signal.removeEventListener("abort", abort);
  if (killTimer) clearTimeout(killTimer);
  await trustedAccessRelease;
  stderr.end();
  try {
    for (const event of input.parser.finish()) enqueue(event);
  } catch (error) {
    parseError ??= error instanceof Error ? error : new Error(String(error));
  }
  try {
    await eventQueue;
  } catch (error) {
    eventError = error;
  }
  const failure = spawnError ?? parseError ?? eventError;
  if (failure) throw failure;
  return { exitCode, aborted, lastEvent, stderrTail: stderr.tail() };
}
