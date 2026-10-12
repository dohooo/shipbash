// The recording's clock, a leaf every reader shares: the capture stamps
// captions, pointers and calls with it (recording-capture.mjs), the stream
// recorder its first frame, and the terminal lanes their shells' output
// (case-attempt.mjs, run-activity.mjs), so a frame, a caption, a call and a
// line of output are placed against each other without a wall-clock step
// moving one of them.

let epochOffsetMs = null;

/**
 * An epoch millisecond read off the monotonic clock through one offset, taken
 * at its first reading and kept for the process, so no wall-clock step moves
 * one reading against another.
 */
export function recordingNow() {
  epochOffsetMs ??= Date.now() - performance.now();
  return Math.round(performance.now() + epochOffsetMs);
}
