/**
 * Target Auth Profile access under a dispatch lease: the read that compares
 * live state against the Run's immutable snapshot, and the two death writers
 * — expired when a task stops on a sign-in wall the saved session should have
 * passed, failed when a sign-in it verified could not be saved. A task's
 * promotion is target-auth-state.ts's, with every other write of a sign-in.
 */
import type postgres from "postgres";

import { lockDispatchJobCapability, lockSuiteRunJob } from "./dispatch-capabilities.ts";
import { nonEmpty } from "./normalize.ts";
import type { DispatchJobLeaseCapability } from "../types.ts";
import type {
  MarkTargetAuthProfileExpiredForJobInput,
  MarkTargetAuthProfileFailedForJobInput,
  TargetAuthProfileForJob,
} from "./job-store-inputs.ts";

export async function readTargetAuthProfileForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
): Promise<TargetAuthProfileForJob | null> {
  return await sql.begin(async (sql) => {
    const job = await lockSuiteRunJob(sql, capability, false);
    const rows = await sql<Array<{
      id: string;
      status: "missing" | "verifying" | "ready" | "expired" | "failed";
      state_version: string | null;
      snapshot_state_version: string | null;
    }>>`
      select profile.id, profile.status, profile.state_version,
        snapshot.auth_profile_state_version as snapshot_state_version
      from public.suite_runs run
      join public.suite_snapshots snapshot
        on snapshot.id = run.suite_snapshot_id and snapshot.team_id = run.team_id
      join public.target_auth_profiles profile
        on profile.id = snapshot.auth_profile_id
       and profile.team_id = run.team_id
       and profile.project_id = run.project_id
      where run.id = ${job.suite_run_id}
        and run.team_id = ${job.team_id}::uuid
        and run.project_id = ${job.project_id}
    `;
    const row = rows[0];
    return row ? {
      id: row.id,
      status: row.status,
      stateVersion: row.state_version,
      snapshotStateVersion: row.snapshot_state_version,
    } : null;
  });
}

/** Owner-visible copy for the saved-session death writers (UI reads failure_reason). */
export const AUTH_PROFILE_EXPIRED_REASON =
  "The saved test account session expired. The run paused so you can sign in again.";
export const AUTH_PROFILE_SAVE_FAILED_REASON =
  "The sign-in this run verified could not be saved, so the next run may pause and ask you to sign in again.";

/**
 * A task's witness that its saved sign-in is dead: it ran with the profile's
 * state injected and still stopped at a sign-in wall, so the profile expires
 * and the owner sees why. The same base as the task's promotion: only a
 * 'ready' profile that still holds the version this task injected flips, so a
 * newer session another run or a person saved is never killed by a stale
 * task. The caller passes that version, since only its preparation knows
 * what it injected (a hosted run may inject a session saved after its Run's
 * snapshot), and calls this only when it injected one.
 */
export async function markTargetAuthProfileExpiredForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  input: MarkTargetAuthProfileExpiredForJobInput,
): Promise<boolean> {
  const profileId = nonEmpty(input.profileId, "profileId");
  return await sql.begin(async (sql) => {
    const job = await lockDispatchJobCapability(sql, capability);
    const rows = await sql`
      update public.target_auth_profiles
      set status = 'expired', failure_reason = ${AUTH_PROFILE_EXPIRED_REASON}, updated_at = now()
      where id = ${profileId}
        and team_id = ${job.team_id}::uuid
        and project_id = ${job.project_id}
        and status = 'ready'
        and state_version is not distinct from ${input.baseStateVersion}
      returning id
    `;
    return Boolean(rows[0]);
  });
}

/**
 * A human sign-in was captured and verified, but saving it terminally failed:
 * the profile says so, in the owner's language, guarded by the base state
 * version so a stale report never clobbers a newer verified session.
 */
export async function markTargetAuthProfileFailedForJob(
  sql: postgres.Sql,
  capability: DispatchJobLeaseCapability,
  input: MarkTargetAuthProfileFailedForJobInput,
): Promise<boolean> {
  const profileId = nonEmpty(input.profileId, "profileId");
  const reason = nonEmpty(input.reason, "reason");
  if (reason.length > 1_000) throw new Error("reason exceeds 1000 characters.");
  return await sql.begin(async (sql) => {
    const job = await lockDispatchJobCapability(sql, capability);
    const rows = await sql`
      update public.target_auth_profiles
      set status = 'failed', failure_reason = ${reason}, updated_at = now()
      where id = ${profileId}
        and team_id = ${job.team_id}::uuid
        and project_id = ${job.project_id}
        and state_version is not distinct from ${input.baseStateVersion}
      returning id
    `;
    return Boolean(rows[0]);
  });
}
