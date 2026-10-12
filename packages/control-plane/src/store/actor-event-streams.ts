/**
 * Actor facet — the narrow reads behind the live lanes: the status a takeover
 * checks, the tick each SSE poll reads past its cursor, what a Run tick that
 * moved sends, and the one event row an evidence download needs.
 */
import { ActorActivitiesStore } from "./actor-activities.ts";
import type { SuiteRunStatus } from "@shipbash/contracts/database-contract-types";
import type { ActivityStatus, TenantActor } from "../types.ts";
import {
  type ActivityEvidence,
  type ActivityStreamTick,
  readActivityEvidence,
  readActivityStatus,
  readActivityStreamTick,
  readSuiteRunStatus,
  readSuiteRunStreamTick,
  type SuiteRunStreamTick,
} from "./event-stream-reads.ts";
import { eventCursor, nonEmpty } from "./normalize.ts";
import { readSuiteRunStreamState, type SuiteRunStreamState } from "./run-stream-state.ts";

export class ActorEventStreamsStore extends ActorActivitiesStore {
  async getActivityStatus(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    activityId: string,
  ): Promise<ActivityStatus | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedActivityId = nonEmpty(activityId, "activityId");
    return this.withActor(actor, async (sql) => readActivityStatus(sql, actor, scopedTeamId, scopedProjectId, scopedActivityId));
  }

  async getSuiteRunStatus(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    runId: string,
  ): Promise<SuiteRunStatus | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedRunId = nonEmpty(runId, "runId");
    return this.withActor(actor, async (sql) => readSuiteRunStatus(sql, actor, scopedTeamId, scopedProjectId, scopedRunId));
  }

  async getActivityStreamTick(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    activityId: string,
    afterSequence: number,
  ): Promise<ActivityStreamTick | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedActivityId = nonEmpty(activityId, "activityId");
    const scopedAfter = eventCursor(afterSequence);
    return this.withActor(actor, async (sql) => readActivityStreamTick(sql, actor, scopedTeamId, scopedProjectId, scopedActivityId, scopedAfter));
  }

  async getSuiteRunStreamTick(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    runId: string,
  ): Promise<SuiteRunStreamTick | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedRunId = nonEmpty(runId, "runId");
    return this.withActor(actor, async (sql) => readSuiteRunStreamTick(sql, actor, scopedTeamId, scopedProjectId, scopedRunId));
  }

  async getSuiteRunStreamState(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    runId: string,
    eventsAfter: number,
  ): Promise<SuiteRunStreamState | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedRunId = nonEmpty(runId, "runId");
    const scopedAfter = eventCursor(eventsAfter);
    return this.withActor(actor, async (sql) => readSuiteRunStreamState(sql, scopedTeamId, scopedProjectId, scopedRunId, scopedAfter));
  }

  async getActivityEvidence(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    activityId: string,
    match: { event: string; sessionId: string | null },
  ): Promise<ActivityEvidence | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedActivityId = nonEmpty(activityId, "activityId");
    const scopedMatch = { event: nonEmpty(match.event, "match.event"), sessionId: match.sessionId };
    return this.withActor(actor, async (sql) => readActivityEvidence(sql, actor, scopedTeamId, scopedProjectId, scopedActivityId, scopedMatch));
  }
}
