/**
 * One event on a Suite Run's evidence trail: it takes the run's next
 * sequence under the run's row lock and moves the sequence on, inside the
 * caller's transaction. The counterpart of appendActivityEventTransaction;
 * the caller owns authorization (a lease, an actor, or the service itself).
 */
import type postgres from "postgres";

import type { RunnerRunEvent } from "../types.ts";
import { mapRunnerRunEvent } from "./dispatch-capabilities.ts";
import { expectRow } from "./expect-row.ts";
import { generatedTextId, safeJsonObject } from "./normalize.ts";
import type { Timestamp } from "./rows.ts";

export interface RunEventAppend {
  teamId: string;
  projectId: string;
  suiteRunId: string;
  caseRunId?: string | null;
  type: string;
  level?: RunnerRunEvent["level"];
  message: string;
  data?: Record<string, unknown> | null;
}

export async function appendRunEventTransaction(
  sql: postgres.TransactionSql,
  input: RunEventAppend,
): Promise<RunnerRunEvent> {
  const runs = await sql<Array<{ next_event_sequence: number | string }>>`
    select next_event_sequence from public.suite_runs
    where id = ${input.suiteRunId} and team_id = ${input.teamId}::uuid
      and project_id = ${input.projectId}
    for update
  `;
  if (!runs[0]) throw new Error("Scoped Suite Run not found.");
  const sequence = Number(runs[0].next_event_sequence);
  const data = safeJsonObject(input.data, "data");
  const rows = await sql<Array<{
    id: string; suite_run_id: string; case_run_id: string | null;
    sequence: number | string; type: string; level: RunnerRunEvent["level"];
    message: string; data: Record<string, unknown> | null; created_at: Timestamp;
  }>>`
    insert into public.run_events (
      id, suite_run_id, case_run_id, sequence, type, level,
      message, data, team_id, project_id
    ) values (
      ${generatedTextId("run_event")}, ${input.suiteRunId}, ${input.caseRunId ?? null}, ${sequence},
      ${input.type}, ${input.level ?? "info"}, ${input.message},
      ${data ? sql.json(data) : null},
      ${input.teamId}::uuid, ${input.projectId}
    )
    returning id, suite_run_id, case_run_id, sequence, type, level,
      message, data, created_at
  `;
  await sql`
    update public.suite_runs set next_event_sequence = ${sequence + 1}
    where id = ${input.suiteRunId} and team_id = ${input.teamId}::uuid
  `;
  return mapRunnerRunEvent(expectRow(rows, "run_events", "insert"));
}
