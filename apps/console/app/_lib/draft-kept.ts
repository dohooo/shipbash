/**
 * What a confirmed review adds, counted by what it is: the button and its
 * toast both name the batch, and a hook counted as a Journey read "Add 10
 * journeys" over nine Journeys and one hook. A kept removal archives a live
 * Journey, so it is counted apart from what the batch adds.
 */
import type { ProposalCase } from "../../lib/web-client";
import { isHookRole } from "./case-slot";

export interface KeptCounts {
  journeys: number;
  hooks: number;
  removals: number;
}

export function keptCounts(cases: readonly ProposalCase[]): KeptCounts {
  const removals = cases.filter((entry) => entry.archived === true).length;
  const hooks = cases.filter((entry) => entry.archived !== true && entry.role !== undefined && isHookRole(entry.role)).length;
  return { journeys: cases.length - removals - hooks, hooks, removals };
}

/** "3 journeys", "1 hook", "9 journeys and 1 hook", "2 journeys and 1 removal". */
export function keptPhrase({ journeys, hooks, removals }: KeptCounts): string {
  return [
    journeys ? `${String(journeys)} ${journeys === 1 ? "journey" : "journeys"}` : null,
    hooks ? `${String(hooks)} ${hooks === 1 ? "hook" : "hooks"}` : null,
    removals ? `${String(removals)} ${removals === 1 ? "removal" : "removals"}` : null,
  ].filter((part) => part !== null).join(" and ");
}
