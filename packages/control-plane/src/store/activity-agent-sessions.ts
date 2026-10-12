/**
 * The pi session an Activity's legs share (activity_agent_sessions): saved
 * whole under the leg's lease as the leg ends, read whole by the host that
 * prepares the next leg. service/dispatch-activity-session.ts moves it
 * between this row and the session directory.
 */
import type postgres from "postgres";

import type { DispatchJobLeaseCapability } from "../types.ts";
import { lockDispatchJobCapability } from "./dispatch-capabilities.ts";
import { activityJob } from "./knowledge.ts";
import { nonEmpty } from "./normalize.ts";

export interface ActivityAgentSession {
  /** The transcript's file name in the session directory, as pi named it. */
  transcriptFile: string;
  /** The transcript pi resumes: JSONL, the redacted copy pi keeps on disk. */
  transcript: string;
  /** journeys.json as the leg left it, when the leg had one. */
  journeyStore: string | null;
}

export async function saveActivityAgentSessionForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  session: ActivityAgentSession,
): Promise<void> {
  await sql.begin(async (transaction) => {
    const job = activityJob(await lockDispatchJobCapability(transaction, capability, false));
    await transaction`
      insert into public.activity_agent_sessions (activity_id, team_id, transcript_file, transcript, journey_store)
      values (${job.activity_id}::uuid, ${job.team_id}::uuid, ${session.transcriptFile}, ${session.transcript}, ${session.journeyStore})
      on conflict (activity_id) do update
      set transcript_file = excluded.transcript_file,
          transcript = excluded.transcript,
          journey_store = excluded.journey_store,
          saved_at = now()
    `;
  });
}

export async function readActivityAgentSession(
  sql: postgres.Sql,
  input: { teamId: string; projectId: string; activityId: string },
): Promise<ActivityAgentSession | null> {
  const [row] = await sql<Array<{ transcript_file: string; transcript: string; journey_store: string | null }>>`
    select session.transcript_file, session.transcript, session.journey_store
    from public.activity_agent_sessions session
    join public.activities activity on activity.id = session.activity_id and activity.team_id = session.team_id
    where session.activity_id = ${nonEmpty(input.activityId, "activityId")}::uuid
      and activity.team_id = ${nonEmpty(input.teamId, "teamId")}::uuid
      and activity.project_id = ${nonEmpty(input.projectId, "projectId")}
  `;
  return row
    ? { transcriptFile: row.transcript_file, transcript: row.transcript, journeyStore: row.journey_store }
    : null;
}
