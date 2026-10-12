/**
 * A run's Cases by role, and the order the verification page's rail reads
 * them in: run-level setup on top, the Suite's per-journey setup next, each
 * Journey numbered among Journeys only with the hooks scoped to it
 * indented before and after, the Suite's per-journey teardown, run-level teardown
 * last. Hooks carry timing labels before their titles; a hook scoped to a
 * Journey names that Journey's number.
 */
import type { RunCaseView } from "@shipbash/contracts/api/view-types";

/** Timing labels; scoped hooks name their Journey. */
export function slotLabel(role: string, nested = false, scopeOrdinal: number | null = null): string | null {
  const scope = nested && scopeOrdinal !== null ? ` · ${String(scopeOrdinal).padStart(2, "0")}` : "";
  if (role === "before_all") return "before all";
  if (role === "after_all") return "after all";
  if (role === "before_each") return nested ? `before${scope}` : "before each";
  if (role === "after_each") return nested ? `after${scope}` : "after each";
  return null;
}

export function runJourneys(cases: readonly RunCaseView[]): RunCaseView[] {
  return cases.filter((suiteCase) => suiteCase.role === "journey");
}

export interface RunRailRow {
  suiteCase: RunCaseView;
  /** The Journey's number among Journeys; null for a hook. */
  ordinal: number | null;
  /** A hook indented under the Journey it is scoped to. */
  nested: boolean;
  /** For a hook scoped to a Journey, that Journey's number; null otherwise. */
  scopeOrdinal: number | null;
}

export function runRailRows(cases: readonly RunCaseView[]): RunRailRow[] {
  const suiteLevel = (role: string) =>
    cases.filter((suiteCase) => suiteCase.role === role && suiteCase.scopeCaseId === null);
  const scopedTo = (journeyId: string, role: string) =>
    cases.filter((suiteCase) => suiteCase.role === role && suiteCase.scopeCaseId === journeyId);
  const row = (suiteCase: RunCaseView, ordinal: number | null = null, scopeOrdinal: number | null = null): RunRailRow =>
    ({ suiteCase, ordinal, nested: scopeOrdinal !== null, scopeOrdinal });
  return [
    ...suiteLevel("before_all").map((suiteCase) => row(suiteCase)),
    ...suiteLevel("before_each").map((suiteCase) => row(suiteCase)),
    ...runJourneys(cases).flatMap((journey, index) => [
      ...scopedTo(journey.id, "before_each").map((suiteCase) => row(suiteCase, null, index + 1)),
      row(journey, index + 1),
      ...scopedTo(journey.id, "after_each").map((suiteCase) => row(suiteCase, null, index + 1)),
    ]),
    ...suiteLevel("after_each").map((suiteCase) => row(suiteCase)),
    ...suiteLevel("after_all").map((suiteCase) => row(suiteCase)),
  ];
}
