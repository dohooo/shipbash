/**
 * Which live Cases a run snapshot freezes. A Journey the owner ruled
 * one_time stays in the Suite but is not walked again, so it stays out of
 * the snapshot — and so does a hook scoped to it: a hook around a
 * Journey nobody walks has no run to be around, and a scope the run input
 * could not resolve to a sibling snapshot Case would read as suite-wide.
 * Suite-level hooks and every repeatable Journey go in as they are.
 */
export function casesWalkedEveryRun<T extends { id: string; role: string; scope_case_id: string | null; repeat: string }>(
  rows: readonly T[],
): T[] {
  return casesForJourneys(
    rows,
    rows.filter((row) => row.role === "journey" && row.repeat === "repeatable").map((row) => row.id),
  );
}

/**
 * The named Journeys and the hooks they walk with: every suite-level hook,
 * and each hook scoped to one of them. A hook scoped to a Journey not named
 * has no walk to be around, so it stays out with that Journey.
 */
export function casesForJourneys<T extends { id: string; role: string; scope_case_id: string | null }>(
  rows: readonly T[],
  journeyIds: readonly string[],
): T[] {
  const named = new Set(journeyIds);
  return rows.filter((row) =>
    row.role === "journey" ? named.has(row.id) : row.scope_case_id === null || named.has(row.scope_case_id));
}
