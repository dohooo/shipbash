/**
 * The shared child-process runner behind both container runners. One
 * implementation, two configurations: a `cancelable: false` option makes the
 * pre-spawn check and cancellation poll stand down, so teardown work
 * survives a cancel, and the Activity runner additionally terminates
 * children the moment the streamed browser is gone (isLifecycleFaulted).
 */
import { spawn } from "node:child_process";

export function childIsRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * Chunks in, whole lines out: the partial tail is held until a later chunk
 * completes it, and delivered at close only if it is not blank. Blank and
 * whitespace-only lines are never delivered.
 */
function createLineSplitter(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          onLine(line);
        }
      }
    },
    flush() {
      if (buffer.trim()) {
        onLine(buffer);
      }
    },
  };
}

/** The cancel / lifecycle-fault watchdog, or undefined when neither is armed. */
function startCancelPoll({ cancelable, isCancelRequested, isLifecycleFaulted, terminate }) {
  if (!cancelable && !isLifecycleFaulted) return undefined;
  const poll = setInterval(() => {
    if (cancelable && isCancelRequested()) {
      terminate(true);
    } else if (isLifecycleFaulted?.()) {
      // The streamed browser is gone; nothing this child does can matter.
      terminate(false);
    }
  }, 250);
  poll.unref();
  return poll;
}

export function createRunProcess({
  register,
  unregister,
  defaultCwd,
  defaultTimeoutMs,
  pipeStderr,
  checkCancellation,
  isCancelRequested,
  isLifecycleFaulted = null,
}) {
  return async function runProcess(command, args, options = {}) {
    const {
      env = process.env,
      cwd = defaultCwd,
      input,
      onStdoutLine,
      captureStdout = true,
      cancelable = true,
      logStderr = true,
      timeoutMs = defaultTimeoutMs,
      controller = null,
    } = options;

    if (cancelable) {
      checkCancellation();
    }
    const startedAt = Date.now();
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      register(child);
      let stdout = "";
      const lines = onStdoutLine ? createLineSplitter(onStdoutLine) : null;
      let timedOut = false;
      let canceled = false;
      let killTimer;

      const terminate = (forCancel) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        canceled ||= forCancel;
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
        killTimer.unref();
      };
      if (controller) controller.terminate = () => terminate(false);

      const poll = startCancelPoll({
        cancelable, isCancelRequested, isLifecycleFaulted, terminate,
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        terminate(false);
      }, timeoutMs);
      timeout.unref();

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (captureStdout) {
          stdout += String(chunk);
          if (stdout.length > 20_000_000) {
            timedOut = true;
            terminate(false);
          }
        }
        lines?.push(String(chunk));
      });
      const stderrTail = { text: "" };
      if (logStderr) pipeStderr(child.stderr, stderrTail);
      else child.stderr.resume();
      child.once("error", reject);
      child.once("close", (code, signal) => {
        unregister(child);
        if (poll) clearInterval(poll);
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        lines?.flush();
        resolve({
          code,
          signal,
          stdout,
          timedOut,
          canceled,
          stderrTail: stderrTail.text,
          durationMs: Date.now() - startedAt,
        });
      });
      if (input !== undefined) {
        child.stdin.on("error", () => {});
        child.stdin.end(input);
      }
    });
  };
}
