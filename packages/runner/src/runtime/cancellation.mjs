// The one cancellation signal both container runtimes raise, lifted out of
// the Activity's state module so the pure judges that rethrow it — the first
// frame's capture and settle — can be called from a lane that is not an
// Activity. Each lane keeps its own wording; what matters is that one class
// answers `instanceof` everywhere, so a cancellation crossing lane modules is
// never mistaken for an infrastructure fault.
import { existsSync } from "node:fs";

/** How often a running agent looks for the cancel sentinel. */
const CANCEL_POLL_MS = 250;

export class CancellationError extends Error {
  /** @param {string} [message] */
  constructor(message = "Canceled.") {
    super(message);
    this.name = "CancellationError";
  }
}

/**
 * One runner's cancellation protocol: a flag the cancel sentinel or a
 * SIGTERM/SIGINT latches, the check that throws the runner's own words once
 * it is set, and the live children a signal stops unless `sparesChildren`
 * says otherwise. Registers the signal handlers when called, so each runner's
 * state module calls it once.
 *
 * @param {{ cancelPath: string, message: string, sparesChildren: () => boolean }} options
 */
export function createCancellation({ cancelPath, message, sparesChildren }) {
  const activeChildren = new Set();
  let requested = false;
  /** The run-process poll: latches the in-memory flag off the cancel sentinel. */
  function pollCancelRequested() {
    if (requested || existsSync(cancelPath)) {
      requested = true;
      return true;
    }
    return false;
  }
  function requestCancellation() {
    requested = true;
    if (sparesChildren()) return;
    for (const child of activeChildren) child.kill("SIGTERM");
  }
  process.once("SIGTERM", requestCancellation);
  process.once("SIGINT", requestCancellation);
  return {
    activeChildren,
    checkCancellation() {
      if (pollCancelRequested()) throw new CancellationError(message);
    },
    pollCancelRequested,
    isCancellationRequested: () => requested,
  };
}

/**
 * Calls `onCancel` once, within a poll of `isRequested` answering true: how a
 * running agent hears the cancel sentinel the worker writes the moment its
 * heartbeat reads the owner's Stop. The timer is unref'd, and the caller's
 * to clear.
 * @param {() => boolean} isRequested
 * @param {() => void} onCancel
 * @returns {NodeJS.Timeout}
 */
export function watchCancel(isRequested, onCancel) {
  const timer = setInterval(() => {
    if (!isRequested()) return;
    clearInterval(timer);
    onCancel();
  }, CANCEL_POLL_MS);
  timer.unref();
  return timer;
}
