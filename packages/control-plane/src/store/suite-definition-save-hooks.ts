/**
 * What the Suite definition save owes its hooks: a per-journey hook's
 * scope names a Journey of the same save (normalize already held it there;
 * this is the write path's own check, so a caller that bypasses normalize
 * cannot write a dangling scope), a scoped hook is written after the
 * Journey it names so the scope foreign key finds its row, and a hook
 * whose Journey is archived — in this save or before it — is archived with
 * it: a hook around a Journey nobody walks is not run, and is not shown
 * as live either.
 */
import type postgres from "postgres";

import { isPerJourneyRole } from "@shipbash/contracts/runtime/case-role-contract.mjs";
import type { NormalizedSuiteCaseInput, SaveSuiteDefinitionArguments } from "./rows.ts";

export function assertHookScopes(cases: readonly NormalizedSuiteCaseInput[]): void {
  const journeys = new Set(cases.filter((suiteCase) => suiteCase.role === "journey").map((suiteCase) => suiteCase.id));
  cases.forEach((suiteCase, index) => {
    if (suiteCase.scopeCaseId == null) return;
    if (!isPerJourneyRole(suiteCase.role)) {
      throw new Error(`cases[${index}].scopeCaseId must only be set for a before_each or after_each hook.`);
    }
    if (!journeys.has(suiteCase.scopeCaseId)) {
      throw new Error(`cases[${index}].scopeCaseId must name a Journey of this Suite.`);
    }
  });
}

/** The Cases in write order: every scoped hook after the Journeys, each keeping its own position. */
export function casesInWriteOrder(
  cases: readonly NormalizedSuiteCaseInput[],
): Array<[position: number, suiteCase: NormalizedSuiteCaseInput]> {
  const entries = [...cases.entries()];
  return [
    ...entries.filter(([, suiteCase]) => suiteCase.scopeCaseId === null),
    ...entries.filter(([, suiteCase]) => suiteCase.scopeCaseId !== null),
  ];
}

/**
 * Archives every live hook scoped to an archived Journey of the Suite,
 * with the revision bump the removal of a Case carries.
 */
export async function archiveOrphanedHooks(
  sql: postgres.TransactionSql,
  input: Pick<SaveSuiteDefinitionArguments, "suiteId" | "teamId">,
): Promise<void> {
  await sql`
    update public.suite_cases hook
    set enabled = false, archived_at = now(), revision = hook.revision + 1, updated_at = now()
    from public.suite_cases journey
    where hook.suite_id = ${input.suiteId}::uuid
      and hook.team_id = ${input.teamId}::uuid
      and hook.archived_at is null
      and journey.id = hook.scope_case_id
      and journey.team_id = hook.team_id
      and journey.archived_at is not null
  `;
}
