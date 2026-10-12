/**
 * How often a job's work is drawn, with no Slack in it: at once when it is
 * taken up, turns to its owner, goes on again or ends, and at most once an
 * interval while it only moves. Whoever draws decides what a draw is — the
 * thread's to-do list in this process (thread-lists.ts), or a call asking the
 * job API to paint it, from a Sandbox that holds no Slack token. A Sandbox
 * leaves the final draw to its Workflow, which makes it once the Sandbox has
 * stopped (settleJobWorkProgress): its lease is gone by then.
 */
import { type WorkProgress, type WorkRef, workKey } from "../dispatch-worker-types.ts";

/** At most one draw of a work per interval while it only moves. */
export const DRAW_INTERVAL_MS = 3_000;

/** The work a job runs, as its row names it; null for a row that names neither. */
export function jobWork(job: { suiteRunId: string | null; activityId: string | null }): WorkRef | null {
  if (job.suiteRunId) return { suiteRunId: job.suiteRunId };
  return job.activityId ? { activityId: job.activityId } : null;
}

/**
 * `moved` draws once after the interval, `changed` and `settle` now; one draw
 * of a work is under way at a time and at most one waits behind it, reading
 * the work when it begins. `quiet` drops the draw waiting out the interval and
 * waits out the one under way. A draw that fails is logged; no call throws.
 */
export function throttledWorkProgress(
  draw: (work: WorkRef) => Promise<void>,
  intervalMs = DRAW_INTERVAL_MS,
): WorkProgress & { quiet(work: WorkRef): Promise<void> } {
  /** By work: a draw waiting out the interval, the last draw asked for, and one asked for that has not begun. */
  const timers = new Map<string, NodeJS.Timeout>();
  const drawing = new Map<string, Promise<void>>();
  const waiting = new Map<string, Promise<void>>();

  function dropTimer(key: string): void {
    clearTimeout(timers.get(key));
    timers.delete(key);
  }

  function now(work: WorkRef): Promise<void> {
    const key = workKey(work);
    dropTimer(key);
    const queued = waiting.get(key);
    if (queued) return queued;
    const next = (drawing.get(key) ?? Promise.resolve())
      .then(() => {
        waiting.delete(key);
        return draw(work);
      })
      .catch((error: unknown) => {
        console.error(`[work-progress] ${key} was not drawn:`, error);
      })
      .finally(() => {
        if (drawing.get(key) === next) drawing.delete(key);
      });
    drawing.set(key, next);
    waiting.set(key, next);
    return next;
  }

  return {
    moved(work) {
      const key = workKey(work);
      if (timers.has(key)) return;
      const timer = setTimeout(() => {
        timers.delete(key);
        void now(work);
      }, intervalMs);
      timer.unref();
      timers.set(key, timer);
    },
    changed: now,
    settle: now,
    async quiet(work) {
      const key = workKey(work);
      dropTimer(key);
      await drawing.get(key);
    },
  };
}
