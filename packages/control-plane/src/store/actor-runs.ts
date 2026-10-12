/**
 * Actor facet — Runs and evidence: run triggers (run-now,
 * rerun, retry-case), run listings and detail, artifact/recording download
 * descriptors, and the overview aggregate.
 */
import { ActorEventStreamsStore } from "./actor-event-streams.ts";
import type {
  DispatchIdentityInput,
  OverviewAggregate,
  RunDispatchResult,
  SuiteRunDetail,
  SuiteRunSummary,
  TenantActor,
} from "../types.ts";
import {
  type ArtifactDownloadDescriptor,
  type BrowserRecordingDownloadDescriptor,
  type WalkArtifact,
  getActivityPage,
  getArtifactDownloadDescriptor,
  getBrowserRecordingDownloadDescriptor,
  getCaseRunPage,
  listCaseRunArtifacts,
} from "./evidence-downloads.ts";
import { eventCursor, nonEmpty, normalizeLimit } from "./normalize.ts";
import { getOverviewAggregate } from "./overview.ts";
import { getSuiteRunDetail, type RunDetailOptions } from "./run-detail.ts";
import { readRunLog, type RunLog } from "./run-log.ts";
import { getSuiteRunShare, setSuiteRunShare, type SuiteRunShare } from "./run-shares.ts";
import { normalizeDispatchScope } from "./run-dispatch.ts";
import { rerunHistoricalSuiteRun, retryCaseRun } from "./run-triggers.ts";
import {
  listSuiteRuns,
  requestSuiteRunCancellation,
  resumeRunsWaitingForSignIn,
  resumeSuiteRunAfterAuth,
} from "./runs.ts";
import { createCurrentSnapshotDispatchTransaction } from "./snapshot-dispatch.ts";

/** The run whose page asks, the member of its family whose log it reads, and the last event it holds. */
function logScope(teamId: string, projectId: string, runId: string, logRunId: string, after: number) {
  return {
    teamId: nonEmpty(teamId, "teamId"),
    projectId: nonEmpty(projectId, "projectId"),
    pageRunId: nonEmpty(runId, "runId"),
    logRunId: nonEmpty(logRunId, "logRunId"),
    after: eventCursor(after),
  };
}

export class ActorRunsStore extends ActorEventStreamsStore {
  async getSuiteRunShare(
    actor: TenantActor, teamId: string, projectId: string, runId: string,
  ): Promise<SuiteRunShare | null> {
    return this.withProjectRole(actor, teamId, projectId, "admin", async (sql) => {
      return getSuiteRunShare(sql, teamId, projectId, nonEmpty(runId, "runId"));
    });
  }

  async setSuiteRunShare(
    actor: TenantActor, teamId: string, projectId: string, runId: string, isPublic: boolean,
  ): Promise<SuiteRunShare | null> {
    return this.withProjectRole(actor, teamId, projectId, "admin", async (sql) => {
      return setSuiteRunShare(sql, teamId, projectId, nonEmpty(runId, "runId"), isPublic, actor.userId);
    });
  }

  async runSuiteNow(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    suiteId: string,
    dispatch: DispatchIdentityInput,
  ): Promise<RunDispatchResult> {
    const scope = normalizeDispatchScope(teamId, projectId, dispatch, this.runQuota);
    return this.withProjectRole(actor, scope.teamId, scope.projectId, "member", async (sql) => {
      return createCurrentSnapshotDispatchTransaction(sql, {
        ...scope,
        suiteId: nonEmpty(suiteId, "suiteId"),
        triggerKind: "manual",
        triggerIdentity: { kind: "manual", actorUserId: actor.userId },
      });
    });
  }

  async rerunHistoricalSuiteRun(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    sourceSuiteRunId: string,
    dispatch: DispatchIdentityInput,
  ): Promise<RunDispatchResult> {
    const scope = normalizeDispatchScope(teamId, projectId, dispatch, this.runQuota);
    return this.withProjectRole(actor, scope.teamId, scope.projectId, "member", async (sql) => {
      return rerunHistoricalSuiteRun(sql, scope, sourceSuiteRunId);
    });
  }

  async retryCaseRun(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    sourceCaseRunId: string,
    dispatch: DispatchIdentityInput,
    expectedSourceSuiteRunId?: string,
  ): Promise<RunDispatchResult> {
    const scope = normalizeDispatchScope(teamId, projectId, dispatch, this.runQuota);
    const expectedRunId = expectedSourceSuiteRunId === undefined
      ? null
      : nonEmpty(expectedSourceSuiteRunId, "expectedSourceSuiteRunId");
    return this.withProjectRole(actor, scope.teamId, scope.projectId, "member", async (sql) => {
      return retryCaseRun(sql, scope, sourceCaseRunId, expectedRunId);
    });
  }

  async listSuiteRuns(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    limit?: number,
  ): Promise<SuiteRunSummary[]> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedLimit = normalizeLimit(limit);
    return this.withActor(actor, async (sql) => listSuiteRuns(sql, actor, scopedTeamId, scopedProjectId, scopedLimit));
  }

  async requestSuiteRunCancellation(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    runId: string,
  ): Promise<SuiteRunSummary> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedRunId = nonEmpty(runId, "runId");
    return this.withProjectRole(actor, scopedTeamId, scopedProjectId, "member", async (sql) => {
      return requestSuiteRunCancellation(sql, scopedTeamId, scopedProjectId, scopedRunId);
    });
  }

  async resumeSuiteRunAfterAuth(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    runId: string,
  ): Promise<boolean> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedRunId = nonEmpty(runId, "runId");
    return this.withProjectRole(actor, scopedTeamId, scopedProjectId, "member", async (sql) => {
      return resumeSuiteRunAfterAuth(sql, scopedTeamId, scopedProjectId, scopedRunId);
    });
  }

  /** The Team's runs parked on a sign-in whose Projects' runs use this way in, resumed now it is ready; answers those it resumed. */
  async resumeRunsWaitingForSignIn(
    actor: TenantActor,
    teamId: string,
    signInId: string,
  ): Promise<string[]> {
    const scope = { teamId: nonEmpty(teamId, "teamId"), signInId: nonEmpty(signInId, "signInId") };
    return this.withTeamRole(actor, scope.teamId, "member", async (sql) => {
      return resumeRunsWaitingForSignIn(sql, scope);
    });
  }

  async getSuiteRunDetail(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    runId: string,
    options: RunDetailOptions = {},
  ): Promise<SuiteRunDetail | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedRunId = nonEmpty(runId, "runId");
    const scopedOptions = {
      // An attempt the caller left out and one it named as empty are the same
      // request: show the page as it reads without one.
      attemptCaseRunId: options.attemptCaseRunId?.trim() || null,
    };
    return this.withActor(actor, async (sql) => getSuiteRunDetail(sql, scopedTeamId, scopedProjectId, scopedRunId, scopedOptions));
  }

  /**
   * The page's log of `logRunId`, a member of `runId`'s family (its page's
   * `activeRun`), written after `after`; null outside the family.
   */
  async getSuiteRunLog(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    runId: string,
    logRunId: string,
    after: number,
  ): Promise<RunLog | null> {
    const scope = logScope(teamId, projectId, runId, logRunId, after);
    return this.withActor(actor, async (sql) => readRunLog(sql, scope));
  }

  async getArtifactDownloadDescriptor(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    runId: string,
    artifactId: string,
  ): Promise<ArtifactDownloadDescriptor | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedRunId = nonEmpty(runId, "runId");
    const scopedArtifactId = nonEmpty(artifactId, "artifactId");
    return this.withProjectRole(actor, scopedTeamId, scopedProjectId, "member", async (sql) => {
      return getArtifactDownloadDescriptor(sql, scopedTeamId, scopedProjectId, scopedRunId, scopedArtifactId);
    });
  }

  async getCaseRunPage(
    actor: TenantActor,
    caseRunId: string,
  ): Promise<{ teamId: string; projectId: string; runId: string } | null> {
    const scopedCaseRunId = nonEmpty(caseRunId, "caseRunId");
    return this.withActor(actor, async (sql) => getCaseRunPage(sql, scopedCaseRunId));
  }

  async getActivityPage(
    actor: TenantActor,
    activityId: string,
  ): Promise<{ teamId: string; projectId: string } | null> {
    const scopedActivityId = nonEmpty(activityId, "activityId");
    return this.withActor(actor, async (sql) => getActivityPage(sql, scopedActivityId));
  }

  async listCaseRunArtifacts(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    caseRunIds: readonly string[],
  ): Promise<WalkArtifact[]> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    return this.withProjectRole(actor, scopedTeamId, scopedProjectId, "member", async (sql) => {
      return listCaseRunArtifacts(sql, scopedTeamId, scopedProjectId, caseRunIds);
    });
  }

  async getBrowserRecordingDownloadDescriptor(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    recordingId: string,
  ): Promise<BrowserRecordingDownloadDescriptor | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedRecordingId = nonEmpty(recordingId, "recordingId");
    return this.withProjectRole(actor, scopedTeamId, scopedProjectId, "member", async (sql) => {
      return getBrowserRecordingDownloadDescriptor(sql, scopedTeamId, scopedProjectId, scopedRecordingId);
    });
  }

  async getOverviewAggregate(
    actor: TenantActor,
    teamId: string,
    projectId: string,
  ): Promise<OverviewAggregate> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    return this.withActor(actor, async (sql) => getOverviewAggregate(sql, actor, scopedTeamId, scopedProjectId));
  }
}
