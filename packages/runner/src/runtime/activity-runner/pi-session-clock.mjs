// The Activity leg's clock: a stopwatch, not a wall clock. It runs while the
// agent works and stands still while a waiting tool (request_choice) holds
// the round for the owner, so a question the owner takes forty minutes to
// answer costs the agent none of its budget, while an agent that never waits
// still meets the deadline. Before this the clock only re-armed whole windows
// around a wait: five answers that took nine minutes between them ended a
// Discovery leg with two Journeys unsaved (a target product). The
// time it stood still is kept, so the record can say how much of the wall
// clock was the owner's.
//
// A hosted leg also lives under a wall-clock ceiling: the Sandbox is deleted
// at a fixed wall time whatever the budget says, so a second deadline that
// never pauses ends the leg first, the same way, while it can still close.

/**
 * @param {{ timeoutMs: number, wallMs?: number | null, onExpire: () => void }} options
 */
export function createSessionClock({ timeoutMs, wallMs = null, onExpire }) {
  let remainingMs = timeoutMs;
  /** Wall time the current working span began; null while waiting or stopped. */
  let runningSince = null;
  /** Wall time the current wait began; null while working. */
  let waitingSince = null;
  let waitDepth = 0;
  let waitedMs = 0;
  let timer = null;
  let wallTimer = null;
  let stopped = false;
  /** @type {"budget" | "wall" | null} */
  let expiredBy = null;

  const expire = (deadline) => {
    if (expiredBy !== null) return;
    expiredBy = deadline;
    onExpire();
  };
  const run = () => {
    if (stopped) return;
    runningSince = Date.now();
    timer = setTimeout(() => {
      timer = null;
      expire("budget");
    }, remainingMs);
    timer.unref?.();
  };
  const halt = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (runningSince !== null) remainingMs = Math.max(0, remainingMs - (Date.now() - runningSince));
    runningSince = null;
  };

  return {
    start() {
      if (wallMs !== null) {
        wallTimer = setTimeout(() => expire("wall"), wallMs);
        wallTimer.unref?.();
      }
      run();
    },
    /** A waiting tool went in flight: the budget stops being spent. */
    pause() {
      waitDepth += 1;
      if (waitDepth > 1) return;
      halt();
      waitingSince = Date.now();
    },
    /** The wait ended: the budget resumes from where it stood. */
    resume() {
      if (waitDepth === 0) return;
      waitDepth -= 1;
      if (waitDepth > 0) return;
      waitedMs += Date.now() - waitingSince;
      waitingSince = null;
      run();
    },
    stop() {
      stopped = true;
      halt();
      if (wallTimer !== null) clearTimeout(wallTimer);
      wallTimer = null;
    },
    /** Milliseconds spent waiting on the owner so far, the open wait included. */
    get waitedMs() {
      return waitedMs + (waitingSince === null ? 0 : Date.now() - waitingSince);
    },
    /** Which deadline ended the leg, once one has. */
    get expiredBy() {
      return expiredBy;
    },
  };
}
