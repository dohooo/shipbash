/**
 * Activity settlement under a dispatch lease: completion, and the wake an
 * Activity owes the messages its closing leg missed
 * (store/leg-missed-steer.ts).
 */
import type postgres from "postgres";
import type { ActivityResultRecord, CompleteActivityInput, DispatchJobLeaseCapability } from "../types.ts";
import { completeActivityTransaction } from "./activity-completion.ts";
import { lockDispatchJobCapability } from "./dispatch-capabilities.ts";
import { transitionLegOwingMissedSteer } from "./leg-missed-steer.ts";

export async function completeActivityForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  input: CompleteActivityInput,
): Promise<ActivityResultRecord> {
  return await sql.begin(async (sql) => {
    const job = await lockDispatchJobCapability(sql, capability);
    if (job.kind !== "activity" || !job.activity_id) {
      throw new Error("Dispatch Job is not an Activity.");
    }
    const result = await completeActivityTransaction(sql, {
      teamId: job.team_id,
      projectId: job.project_id,
      activityId: job.activity_id,
      input,
      skipDispatchJobUpdate: true,
    });
    const delivered = input.status === "completed" || input.status === "superseded";
    await transitionLegOwingMissedSteer(sql, job, capability, delivered ? "completed" : "failed", delivered ? null : result.summary);
    return result;
  });
}
