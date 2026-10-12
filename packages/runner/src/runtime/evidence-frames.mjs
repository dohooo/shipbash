/**
 * The evidence recorder's view of the stream: the latest screencast frame, the
 * wait that lets the page settle before a step is photographed, and why a step
 * was left without a picture. Split from evidence-recorder.mjs, which keeps the
 * step log, the console log and the socket.
 */
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/**
 * How long a lost source's browser may stay silent before a step that failed
 * on it is taken for a browser that has stopped answering: ShipBash's fault,
 * not the product's. A stall that ends sooner (a Sandbox starved for 15–30 s)
 * gets its picture once the browser answers again. Apart from the stream's
 * first-frame bound, which is for a page slow to paint, not a browser gone
 * silent.
 */
export const UNRESPONSIVE_AFTER_MS = 60_000;

/**
 * Why a step has no picture, in the words either lane's evidence gate stops
 * a walk with (jev-stops.mjs JEV_REASONS).
 * @typedef {{ reason: "evidence_not_retained" | "browser_gone" } | { reason: "browser_unresponsive", silentMs: number }} StepMissing
 */
/** @type {StepMissing} */
export const NOT_RETAINED = Object.freeze({ reason: "evidence_not_retained" });

function frameHash(buffer) {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

/**
 * The latest screencast frame, and the wait that lets the page settle before a
 * step is photographed: Chromium only emits a frame when pixels change, so a
 * stability window with no new frame means the action has landed.
 *
 * Only a frame of the page as it is now can be a step's picture, and the
 * sidecar says in-band which frames those are: every discontinuity in the
 * picture — the source lost or attached again, another tab followed, a
 * blackout begun or lifted — starts a new generation, announced at once in a
 * status. The tracker keeps the latest status and accepts a frame only while
 * that status is connected and names the frame's generation; a new status
 * empties `latest`, so a frame from before the discontinuity (the one a
 * joining recorder is handed, or the last one before a loss) is never taken
 * for the page as it is now.
 *
 * With no current frame there is nothing to settle on, and a step waits for
 * the next one, never less than a settle bound after the step itself, so a
 * step whose own repaint comes after a long gap is still pictured. While the
 * source is connected it waits at most `firstFrameTimeoutMs` after the
 * recorder lost its frame (the stream's start, or the last new status):
 * Chromium sends a first frame only once it composites the page, which took
 * 4–6 s on a Sandbox busy starting a Case's tooling
 * (measured). While the source is lost it waits
 * until the browser has been silent `unresponsiveAfterMs`, counted from when
 * it last answered, as the sidecar's lost status says.
 *
 * A status that says the browser is gone is final: no frame will come again,
 * so no step waits for one. A step left without a picture says why
 * (`missing`): the browser is gone; the step itself failed on a browser silent
 * past the bound; or the recording kept none.
 * @param {{ now: () => number, stabilityTimeoutMs: number, stabilityWindowMs: number, firstFrameTimeoutMs: number, unresponsiveAfterMs: number }} options
 */
export function createFrameTracker({ now, stabilityTimeoutMs, stabilityWindowMs, firstFrameTimeoutMs, unresponsiveAfterMs }) {
  /** @type {{ buffer: Buffer, hash: string, receivedAt: number, generation: number } | null} */
  let latest = null;
  let source = { connected: false, generation: null };
  // When the recorder last had no current frame to offer.
  let gapSince = now();
  // The recorder's socket closed, or the browser is gone: no frame will come again.
  let ended = false;
  let gone = false;
  // While the source is lost: when its browser last answered.
  let silentSince = null;
  const end = () => {
    ended = true;
    latest = null;
  };
  return {
    end,
    current: () => latest,
    /**
     * Why a step that got no picture has none.
     * @param {boolean} failed whether the step's own tool call failed
     * @returns {StepMissing}
     */
    missing(failed) {
      if (gone) return { reason: "browser_gone" };
      const silentMs = silentSince === null ? 0 : now() - silentSince;
      if (failed && silentSince !== null && silentMs >= unresponsiveAfterMs) return { reason: "browser_unresponsive", silentMs };
      return NOT_RETAINED;
    },
    /** @param {{ connected: boolean, generation: number, gone?: boolean, silentSince?: number | null }} status */
    onStatus({ connected, generation, gone: sourceGone, silentSince: lastAnswered }) {
      if (sourceGone === true) {
        gone = true;
        end();
      }
      silentSince = !connected && typeof lastAnswered === "number" ? lastAnswered : null;
      if (connected === source.connected && generation === source.generation) return;
      source = { connected, generation };
      latest = null;
      gapSince = now();
    },
    /** @param {{ data: string, generation: number }} frame */
    accept({ data, generation }) {
      if (!source.connected || generation !== source.generation) return;
      try {
        const buffer = Buffer.from(data, "base64");
        latest = { buffer, hash: frameHash(buffer), receivedAt: now(), generation };
      } catch {
        // A malformed frame only costs us that frame.
      }
    },
    /** @param {number} stepStart */
    async settled(stepStart) {
      // When this step first had a frame to settle on.
      let settling = null;
      for (;;) {
        const frame = latest;
        if (ended) return null;
        if (!frame) {
          settling = null;
          const bound = silentSince === null ? gapSince + firstFrameTimeoutMs : silentSince + unresponsiveAfterMs;
          if (now() >= Math.max(bound, stepStart + stabilityTimeoutMs)) return null;
        } else {
          settling ??= now();
          if (now() - frame.receivedAt >= stabilityWindowMs || now() - settling >= stabilityTimeoutMs) return frame;
        }
        await delay(50);
      }
    },
  };
}
