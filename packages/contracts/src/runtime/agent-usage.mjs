/**
 * One model response's token counters under the names every `agent_usage`
 * record carries, whichever agent made the call and whichever side reads it:
 * the runner's agents and the host's conversation turns build their records
 * with it, and the host reads a record back through it. `input` is the
 * uncached input (pi subtracts the cached and cache-written tokens), then the
 * cache reads, the cache writes, the output and the total, which pi names
 * `totalTokens`. Counts only, never a price: a cost is worked out later at
 * whatever rate applies.
 */
const COUNTERS = ["input", "cacheRead", "cacheWrite", "output"];

/** The safe, non-negative integer the counter holds, or undefined. */
function counter(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function agentUsageCounts(usage) {
  /** @type {Record<string, number>} */
  const counts = {};
  if (typeof usage !== "object" || usage === null) return counts;
  for (const name of COUNTERS) {
    const count = counter(usage[name]);
    if (count !== undefined) counts[name] = count;
  }
  const total = counter(usage.total) ?? counter(usage.totalTokens);
  if (total !== undefined) counts.total = total;
  return counts;
}
