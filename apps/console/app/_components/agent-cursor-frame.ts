/**
 * The cursor's frame clock: one animation frame paired with a timeout of the
 * same cadence, so a throttled or hidden tab still advances the animation.
 */

interface FrameHandle {
  rafId: number;
  timeoutId: number;
}

export type CursorFrameHandle = FrameHandle | number;

export const MIN_FRAME_SECONDS = 1 / 60;

export function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function requestCursorFrame(callback: (timestamp: number) => void): CursorFrameHandle {
  if (typeof window === "undefined") {
    callback(now());
    return 0;
  }
  if (window.requestAnimationFrame == null) {
    return window.setTimeout(() => callback(now()), MIN_FRAME_SECONDS * 1000);
  }
  let done = false;
  const frame: FrameHandle = {
    rafId: 0,
    timeoutId: 0,
  };
  const run = (timestamp: number) => {
    if (done) {
      return;
    }
    done = true;
    window.clearTimeout(frame.timeoutId);
    window.cancelAnimationFrame(frame.rafId);
    callback(timestamp);
  };
  frame.rafId = window.requestAnimationFrame(run);
  frame.timeoutId = window.setTimeout(() => run(now()), MIN_FRAME_SECONDS * 1000);
  return frame;
}

export function cancelCursorFrame(id: CursorFrameHandle): void {
  if (typeof window === "undefined") {
    return;
  }
  if (typeof id === "object") {
    window.clearTimeout(id.timeoutId);
    window.cancelAnimationFrame?.(id.rafId);
    return;
  }
  if (window.cancelAnimationFrame != null) {
    window.cancelAnimationFrame(id);
    return;
  }
  window.clearTimeout(id);
}
