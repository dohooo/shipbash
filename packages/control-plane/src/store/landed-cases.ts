/**
 * What a keep landed on a Suite: the Cases it added, rewrote or archived,
 * read from the Suite's Cases before and after the keep in its transaction.
 * A keep answers with these, so a client reports what the server applied
 * rather than what it asked for, and its verification walks the Journeys
 * they touch.
 */
import type postgres from "postgres";

import { liveCaseDefinitions } from "./journey-edit-staging.ts";
import type { NormalizedSuiteCaseInput } from "./rows.ts";

/** The live Cases whose definition is new or differs, then the live ones gone. */
export function landedCaseIds(
  before: readonly NormalizedSuiteCaseInput[],
  after: readonly NormalizedSuiteCaseInput[],
): string[] {
  const live = (cases: readonly NormalizedSuiteCaseInput[]) =>
    new Map(cases.filter((entry) => !entry.archived).map((entry) => [entry.id, JSON.stringify(entry)]));
  const was = live(before);
  const now = live(after);
  return [
    ...[...now].filter(([id, definition]) => was.get(id) !== definition).map(([id]) => id),
    ...[...was.keys()].filter((id) => !now.has(id)),
  ];
}

/** The Cases a keep changed on the Suite, from the live Cases read before it. */
export async function landedOnSuite(
  sql: postgres.TransactionSql,
  teamId: string,
  suiteId: string,
  before: readonly NormalizedSuiteCaseInput[],
): Promise<string[]> {
  return landedCaseIds(before, await liveCaseDefinitions(sql, teamId, suiteId, true));
}

/**
 * The Journeys whose walk a keep changed: each Journey it landed, and the
 * Journey each scoped hook it landed walks around. Undefined, the whole
 * Suite, when it landed a suite-level hook, which every Journey walks with.
 * Which of them a run walks is the snapshot's to decide (snapshot-cases.ts).
 */
export async function journeysToVerify(
  sql: postgres.TransactionSql,
  teamId: string,
  suiteId: string,
  landed: readonly string[],
): Promise<string[] | undefined> {
  const rows = await sql<Array<{ id: string; role: string; scope_case_id: string | null }>>`
    select id, role, scope_case_id from public.suite_cases
    where team_id = ${teamId}::uuid and suite_id = ${suiteId}::uuid
      and id = any(${sql.array([...landed])}::uuid[])
  `;
  if (rows.some((row) => row.role !== "journey" && row.scope_case_id === null)) return undefined;
  return [...new Set(rows.map((row) => row.scope_case_id ?? row.id))];
}
