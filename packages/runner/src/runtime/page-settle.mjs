/**
 * One settle rule, applied once, where an action's effect is observed: the
 * MCP proxy's post-action observation (agent-browser-observation.mjs), which
 * every caller of the browser tools reads through — the pi agents and Jev's
 * execution loop (jev-executor.mjs) alike.
 *
 * An action's observation is the page it produced, never the frame it left
 * behind. A click can be snapshotted before the SPA has rendered its
 * destination; a checkpoint judged against the page the click departed
 * reports a failure the settled screenshots contradict. A stale frame is not a
 * contradiction; it is no evidence yet.
 *
 * The rule: read, wait, read again, and take the first reading that repeats.
 * Readings are compared on the URL and on the snapshot's comparable state, so
 * a spinner's changing text does not count as motion; a reading that carries
 * the terminal's screen beside the page (Jev's walk) is compared on that
 * screen too. A page that never stops changing is still a page, so the last
 * reading is returned once the budget is spent.
 *
 * Settled is not done. A busy frame — "Deleting…" on a disabled button while
 * the product finishes a request — repeats itself and so is the settled
 * reading of the click that produced it; it is also the frame a wait must
 * outlast. Jev's wait (jev-executor.mjs) therefore asks the opposite question
 * of the same readings: not "has the page stopped changing" but "has it moved
 * on from this one". A fixed 300 ms wait read the same busy frame on every
 * teardown and handed off to the supervisor.
 */
import { setTimeout as delay } from "node:timers/promises";

const SETTLE_INTERVAL_MS = 300;
const SETTLE_MAX_MS = 4_000;
// Five seconds. A page that will move does so within a few seconds; a page
// that will not (a target product after Confirm delete: the
// delete lands server-side, the Settings page stays) must not be waited on —
// thirty seconds per wait made every teardown 90–160 s. The walk goes to the
// checkpoint's own surface instead, as a step of the Case.
const MOVE_MAX_MS = 5_000;

/**
 * A snapshot's comparable state: its accessibility rows, without free prose
 * and without element refs. agent-browser 0.38 keeps a ref for as long as its
 * node lives and never reuses one, so a re-render that remounts the same rows
 * gives them new refs while the page shows exactly what it showed before.
 */
export function pageState(snapshot) {
  return snapshot
    .split("\n")
    .filter((line) => /^\s*- /u.test(line))
    .map((line) => line.replace(/\bref=e\d+/gu, "ref"))
    .join("\n");
}

/**
 * @typedef {{ url: string, snapshot: string, terminal?: { screen: string } | null }} Reading
 */

/**
 * What a reading shows, as every comparison of two readings compares it:
 * equal keys, the same page.
 * @param {Reading} reading
 */
export const readingKey = (reading) =>
  JSON.stringify([reading.url, pageState(reading.snapshot), reading.terminal?.screen ?? null]);

/**
 * The settled reading of the page, or the last one taken when `maxMs` runs
 * out. An aborted signal throws, as every caller of a browser read expects.
 * @template {Reading} T
 * @param {() => Promise<T>} read
 * @param {{ intervalMs?: number, maxMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<T>}
 */
export async function settledPage(read, options = {}) {
  const { intervalMs = SETTLE_INTERVAL_MS, maxMs = SETTLE_MAX_MS, signal } = options;
  signal?.throwIfAborted();
  const deadline = Date.now() + maxMs;
  let previous = await read();
  while (Date.now() < deadline) {
    await delay(intervalMs, undefined, { signal });
    const current = await read();
    if (readingKey(current) === readingKey(previous)) return current;
    previous = current;
  }
  return previous;
}

/**
 * The settled page once it has moved on from `from` — a different URL, a
 * different comparable state or a different terminal screen — or the last
 * reading taken, unchanged, when `maxMs` runs out. An aborted signal throws,
 * as `settledPage` does.
 * @template {Reading} T
 * @param {() => Promise<T>} read
 * @param {Reading} from the reading the page must leave behind
 * @param {{ intervalMs?: number, maxMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<T | Reading>}
 */
export async function movedPage(read, from, options = {}) {
  const { intervalMs = SETTLE_INTERVAL_MS, maxMs = MOVE_MAX_MS, signal } = options;
  signal?.throwIfAborted();
  const reference = readingKey(from);
  const deadline = Date.now() + maxMs;
  let current = from;
  while (Date.now() < deadline) {
    await delay(intervalMs, undefined, { signal });
    current = await read();
    if (readingKey(current) !== reference) return settledPage(read, { intervalMs, signal });
  }
  return current;
}
