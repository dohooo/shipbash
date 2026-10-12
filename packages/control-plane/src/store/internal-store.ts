/**
 * The internal/trusted store facet: schedulers, GitHub connection changes and
 * reads, dispatch queue reservations and reconcilers — plus the one RLS escape
 * hatch (runtimeSessionsSql), which stays here and nowhere wider. Chained over
 * internal-lanes-slack.ts and internal-lanes.ts to keep each file a readable
 * unit.
 */
import type postgres from "postgres";

import { InternalSlackStore } from "./internal-lanes-slack.ts";
import type {
  DispatchIdentityInput,
  GitHubRead,
  ScheduledDispatchResult,
  SuiteSchedule,
} from "../types.ts";
import {
  reconcileArchivedProjectDispatchJobs,
  reconcileExpiredDispatchCancellations,
  reconcileExpiredVercelDispatchJobs,
} from "./dispatch-reconcilers.ts";
import { reconcileExpiredWaitingDispatchJobs } from "./dispatch-waiting-expiry.ts";
import { reapStrandedSignIns } from "./sign-in-verification-reaper.ts";
import {
  type ClaimableDispatchTask,
  listDispatchTasks,
  releaseVercelDispatchReservation,
  reserveVercelDispatchTasks,
  type VercelDispatchReservation,
} from "./dispatch-tasks.ts";
import { applyGitHubConnectionChange, type GitHubConnectionChange } from "./github-installations.ts";
import type { DueSuiteScheduleDispatch } from "./rows.ts";
import { dispatchDueSuiteSchedules, dispatchScheduledRunBySchedule } from "./schedule-dispatch.ts";
import { listActiveSuiteSchedules } from "./suite-schedules.ts";
import {
  claimBindingsDueForRead,
  type DueRead,
  markProjectRepositoryInaccessible,
  recordProjectRepositoryRead,
} from "./project-repositories.ts";
import { listTeamUsage, setTeamRunQuota, type TeamUsage } from "./team-usage.ts";
import {
  admitWaitlistRequest,
  listWaitlistRequests,
  setWaitlistShelved,
  type WaitlistRequest,
  type WaitlistStanding,
} from "./waitlist.ts";

export class InternalStore extends InternalSlackStore {
  async listActiveSuiteSchedulesInternal(): Promise<SuiteSchedule[]> {
    return listActiveSuiteSchedules(this.sql);
  }

  async dispatchDueSuiteSchedulesInternal(input: {
    dueAt: string;
    limit?: number;
    dispatch: Omit<DispatchIdentityInput, "idempotencyKey" | "identityHash">;
  }): Promise<DueSuiteScheduleDispatch[]> {
    return dispatchDueSuiteSchedules(this.sql, input, this.runQuota);
  }

  async dispatchScheduledRunInternal(
    scheduleId: string,
    scheduledFor: string,
    dispatch: Omit<DispatchIdentityInput, "idempotencyKey">,
    sourceJobId: string | null = null,
  ): Promise<ScheduledDispatchResult> {
    return dispatchScheduledRunBySchedule(this.sql, scheduleId, scheduledFor, dispatch, sourceJobId, this.runQuota);
  }

  /** What GitHub was seen to do to a connection: an owner approved or declined it, or its access went or came back. */
  async applyGitHubConnectionChangeInternal(connectionId: string, change: GitHubConnectionChange): Promise<void> {
    await this.sql.begin((sql) => applyGitHubConnectionChange(sql, connectionId, change));
  }

  async recordGitHubReadInternal(bindingId: string, read: GitHubRead): Promise<void> {
    await recordProjectRepositoryRead(this.sql, bindingId, read);
  }

  async markGitHubBindingInaccessibleInternal(bindingId: string): Promise<void> {
    await markProjectRepositoryInaccessible(this.sql, bindingId);
  }

  async claimGitHubBindingsDueForReadInternal(input: { staleMinutes: number; limit: number }): Promise<DueRead[]> {
    return claimBindingsDueForRead(this.sql, input);
  }

  async listDispatchTasksInternal(limit = 100): Promise<ClaimableDispatchTask[]> {
    return listDispatchTasks(this.sql, limit);
  }

  async reserveVercelDispatchTasksInternal(limit = 100): Promise<VercelDispatchReservation[]> {
    return reserveVercelDispatchTasks(this.sql, limit);
  }

  async releaseVercelDispatchReservationInternal(
    jobId: string,
    reservationId: string,
  ): Promise<boolean> {
    return releaseVercelDispatchReservation(this.sql, jobId, reservationId);
  }

  async reconcileExpiredDispatchCancellationsInternal(limit = 100): Promise<number> {
    return reconcileExpiredDispatchCancellations(this.sql, limit);
  }

  async reconcileArchivedProjectDispatchJobsInternal(limit = 100): Promise<number> {
    return reconcileArchivedProjectDispatchJobs(this.sql, limit);
  }

  async reconcileExpiredVercelDispatchJobsInternal(limit = 100): Promise<number> {
    return reconcileExpiredVercelDispatchJobs(this.sql, limit);
  }

  async reconcileExpiredWaitingDispatchJobsInternal(limit = 100): Promise<number> {
    return reconcileExpiredWaitingDispatchJobs(this.sql, limit);
  }

  /**
   * Sign-ins whose verification leg never came back, across every Team. A row
   * nobody reopens the page for would otherwise say `verifying` for good, so
   * the sweep runs beside the dispatch reconcilers rather than waiting for a
   * reader (service/sign-in-reaper.ts holds the rule and the lazy half).
   */
  async reapStrandedSignInsInternal(strandedBefore: Date, limit = 100): Promise<number> {
    return (await reapStrandedSignIns(this.sql, { strandedBefore, limit })).length;
  }

  /**
   * The waiting list, whole. No actor: there is no account behind the shared
   * password the internal lane is authorized by, and nothing here is scoped to
   * a Team.
   */
  async listWaitlistRequests(): Promise<WaitlistRequest[]> {
    return listWaitlistRequests(this.sql);
  }

  async setWaitlistShelved(userId: string, shelved: boolean): Promise<void> {
    await setWaitlistShelved(this.sql, userId, shelved);
  }

  /** Every team's usage this month, for the same internal lane: no actor, every Team. */
  async listTeamUsage(): Promise<TeamUsage[]> {
    return listTeamUsage(this.sql);
  }

  /** False when there is no such team. */
  async setTeamRunQuota(teamId: string, quota: number | null): Promise<boolean> {
    return setTeamRunQuota(this.sql, teamId, quota);
  }

  /**
   * One transaction for all three effects: the row closes, the account gains
   * the membership claim, and `beforeCommit` sends the mail. A send that
   * throws takes the admission back down with it.
   */
  async admitWaitlistRequest(
    userId: string,
    beforeCommit: (request: WaitlistStanding) => Promise<void>,
  ): Promise<void> {
    await this.sql.begin(async (sql) => {
      await admitWaitlistRequest(sql, userId, beforeCommit);
    });
  }

  runtimeSessionsSql(): postgres.Sql { return this.sql; } // src/store/runtime-session*.ts only
}
