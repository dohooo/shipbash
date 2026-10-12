/**
 * An estimate of a team's recorded usage in US dollars, at list prices for
 * the model, Sandbox time and Jev. Only the facts are stored (agent_usage
 * token counters, Sandbox start and end times, Jev decisions); the estimate is
 * computed here when it is read. Uncached input is priced as a cache write
 * (1.25x the input price), because the API bills each agent turn's new suffix
 * as one; reasoning tokens are part of the output count.
 *
 * Sandbox time undercounts, plainly: it counts each Activity's last leg and
 * work that has ended. Waking an Activity clears its started_at and
 * completed_at (store/activities.ts), no per-leg record exists, and a run or
 * Activity under way counts once it ends. A conversation runs on the host
 * (HOST_KINDS) and holds no Sandbox.
 */
const RATES = {
  uncachedInputPerMillionTokens: 2.5,
  cachedInputPerMillionTokens: 0.1,
  outputPerMillionTokens: 10,
  sandboxPerHour: 0.38,
  jevInputTokensPerRequest: 1_936,
  jevInputPerMillionTokens: 0.042,
} as const;

/** A period's usage as recorded: pi's token counters summed, Sandbox seconds and Jev requests. */
export interface UsageFacts {
  /** pi's `input`: the uncached input. */
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  sandboxSeconds: number;
  jevRequests: number;
}

const MILLION = 1_000_000;

export function usageCostUsd(usage: UsageFacts): number {
  const model = (usage.inputTokens + usage.cacheWriteTokens) * RATES.uncachedInputPerMillionTokens
    + usage.cacheReadTokens * RATES.cachedInputPerMillionTokens
    + usage.outputTokens * RATES.outputPerMillionTokens;
  const jev = usage.jevRequests * RATES.jevInputTokensPerRequest * RATES.jevInputPerMillionTokens;
  return (model + jev) / MILLION + (usage.sandboxSeconds / 3_600) * RATES.sandboxPerHour;
}
