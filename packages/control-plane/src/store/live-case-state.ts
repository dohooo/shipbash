/**
 * What a change_suite candidate inherits from the live Case it names.
 *
 * Preconditions: a candidate may carry them (the agent's annotation, kept
 * through review); an empty list means "not carried", never "cleared", so
 * the live Case's preconditions are inherited instead of wiped.
 *
 * Definition objects: a candidate that says the same thing as the live Case
 * (journey-equivalence.ts) takes the live Case's own `steps` and
 * `checkpoints` objects, byte for byte. Anything less — renumbered step ids,
 * an anchor spelled `null` where the row has no key — reads as a content
 * change to the save path, bumps the Case's revision, and turns a verified
 * Journey unverified. Used when a Discovery's list is persisted
 * and again when any change_suite is applied, so the review round trip
 * cannot reintroduce the difference.
 */
import type postgres from "postgres";

import { sameJourneyDefinition } from "./journey-equivalence.ts";
import { journeyCheckpoints, journeySteps, storedPreconditions } from "./normalize.ts";
import type { NormalizedSuiteCaseInput } from "./rows.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

interface LiveCaseRow {
  id: string;
  title: string;
  steps: unknown;
  category: string;
  checkpoints: unknown;
  why_it_matters: string | null;
  preconditions: unknown;
  role: string;
  scope_case_id: string | null;
  repeat: string;
}

export async function withLiveCaseState(
  sql: Queryable,
  teamId: string,
  suiteId: string,
  cases: NormalizedSuiteCaseInput[],
): Promise<NormalizedSuiteCaseInput[]> {
  const rows = await sql<LiveCaseRow[]>`
    select id, title, steps, category, checkpoints, why_it_matters, preconditions,
      role, scope_case_id, repeat
    from public.suite_cases
    where suite_id = ${suiteId}::uuid and team_id = ${teamId}::uuid
  `;
  const live = new Map(rows.map((row) => [row.id, row]));
  return cases.map((entry) => {
    const row = live.get(entry.id);
    if (!row) return entry;
    // The candidate always carries role, scope, and repeat (normalize
    // defaults them); they are compared, never inherited.
    const stored = {
      title: row.title,
      category: row.category,
      whyItMatters: row.why_it_matters,
      steps: journeySteps(row.steps),
      checkpoints: journeyCheckpoints(row.checkpoints),
      role: row.role,
      scopeCaseId: row.scope_case_id,
      repeat: row.repeat,
    };
    return {
      ...entry,
      ...(sameJourneyDefinition(entry, stored) ? { steps: stored.steps, checkpoints: stored.checkpoints } : {}),
      preconditions: entry.preconditions.length === 0 ? storedPreconditions(row.preconditions) : entry.preconditions,
    };
  });
}
