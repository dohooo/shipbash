/**
 * How many Runs a verification counts toward its team's monthly allowance,
 * from what the runner reported of the walks it finished, as each walk's
 * completion records it on its Case Run: `walk_ms`, the time the runner
 * spent walking it (its execution rounds, never a wait for a person to sign
 * in), and for a before_each or after_each walk the Journey it surrounds
 * (`journey_case_id`).
 *
 * A Journey counts when the runner walked it. Its time is its own walks,
 * plus the before_each and after_each walks around it, plus an equal share of
 * the run's before_all and after_all walks; it counts max(1, ceil(time / 3
 * minutes)) Runs. A Journey its setup kept from walking, or one never
 * reached, counts none, and so does a hook walk around it. A run that walked
 * no Journey counts none.
 */
import type { SuiteCaseRole } from "@shipbash/contracts/database-contract-types";

/** The walking time one Run covers. */
const RUN_MS = 180_000;

/** One walk the runner finished and timed. */
export interface CaseWalk {
  role: SuiteCaseRole;
  /** The Case walked. */
  caseId: string;
  walkMs: number;
  /** The Journey a before_each or after_each walk surrounds; null for any other walk. */
  journeyCaseId: string | null;
}

export function runUnits(walks: readonly CaseWalk[]): number {
  const journeyMs = new Map<string, number>();
  for (const walk of walks) {
    if (walk.role === "journey") journeyMs.set(walk.caseId, (journeyMs.get(walk.caseId) ?? 0) + walk.walkMs);
  }
  if (journeyMs.size === 0) return 0;
  let sharedMs = 0;
  for (const walk of walks) {
    if (walk.role === "before_all" || walk.role === "after_all") sharedMs += walk.walkMs;
    if (walk.role !== "before_each" && walk.role !== "after_each") continue;
    const journey = walk.journeyCaseId;
    if (journey !== null && journeyMs.has(journey)) journeyMs.set(journey, (journeyMs.get(journey) ?? 0) + walk.walkMs);
  }
  // Each Journey's share of the run's own hooks is sharedMs / count; scaling
  // by count keeps the arithmetic in whole milliseconds, so a Journey exactly
  // on a boundary is never tipped over it by a rounding error.
  const count = journeyMs.size;
  let units = 0;
  for (const ms of journeyMs.values()) {
    units += Math.max(1, Math.ceil((ms * count + sharedMs) / (RUN_MS * count)));
  }
  return units;
}
