/**
 * The setup and teardown hooks as the Journeys surfaces read them: grouped
 * by slot in run order, scoped to one Journey or to every one, and named for
 * who wrote them. A hook is a Case, so its results and verdict come free.
 */
import type { Route } from "next";

import { HOOK_ROLES, type HookRole, perJourneySlot } from "./case-slot";
import type { AttentionItem, ProjectJourney } from "./journeys";

/** Who wrote the hook: the owner by hand, or ShipBash on a walk. */
export function hookAuthor(origin: ProjectJourney["origin"]): string {
  return origin === "manual" ? "You" : "ShipBash";
}

/** The block's groups in run order; a slot with no hook has no group. */
export function hooksBySlot(
  hooks: readonly ProjectJourney[],
): Array<{ role: HookRole; hooks: ProjectJourney[] }> {
  return HOOK_ROLES
    .map((role) => ({ role, hooks: hooks.filter((hook) => hook.role === role) }))
    .filter((group) => group.hooks.length > 0);
}

/**
 * What the row's scope chip says: nothing in a per-run slot, whose group
 * heading already says once per run; otherwise every Journey or the one.
 */
export function hookScopeLabel(
  hook: ProjectJourney,
  journeys: ReadonlyArray<Pick<ProjectJourney, "id" | "title">>,
): string | null {
  if (!perJourneySlot(hook.role)) return null;
  if (hook.scopeCaseId === null) return "Every journey";
  const journey = journeys.find((entry) => entry.id === hook.scopeCaseId);
  return `Only ${journey?.title ?? "one journey"}`;
}

/**
 * What runs around one Journey, in walk order: the Suite's before_each, its
 * own before_each, the Journey, its own after_each, the Suite's after_each.
 * The Suite's are inherited; only its own are edited here.
 */
export function hooksAroundJourney(
  hooks: readonly ProjectJourney[],
  journey: Pick<ProjectJourney, "id" | "suiteId">,
): Array<{ hook: ProjectJourney; inherited: boolean }> {
  const inSuite = hooks.filter((hook) => hook.suiteId === journey.suiteId);
  const rows = (role: HookRole, scopeCaseId: string | null) => inSuite
    .filter((hook) => hook.role === role && hook.scopeCaseId === scopeCaseId)
    .map((hook) => ({ hook, inherited: scopeCaseId === null }));
  return [
    ...rows("before_each", null),
    ...rows("before_each", journey.id),
    ...rows("after_each", journey.id),
    ...rows("after_each", null),
  ];
}

/**
 * Overview rows for teardown that failed on its last run. The Journeys'
 * verdicts stand, so nothing else on the page says it.
 */
export function failedTeardownItems(
  hooks: readonly ProjectJourney[],
  teamHref: (pathname: string) => Route,
): AttentionItem[] {
  return hooks
    .filter((hook) => (hook.role === "after_each" || hook.role === "after_all")
      && (hook.latestVerdict === "failed" || hook.latestVerdict === "error"))
    .map((hook) => ({
      id: `hook-${hook.id}`,
      title: `Teardown failed · ${hook.title}`,
      body: "The journeys' verdicts stand. What it cleans up may be left behind until it passes.",
      actionLabel: "View hooks",
      href: teamHref("/journeys#before-after"),
    }));
}
