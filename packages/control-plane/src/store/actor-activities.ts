/**
 * Actor facet — Activities: listing, creation and cancellation doors, the
 * auth resume, and retry (which re-reads the source Activity under the
 * actor's role before dispatching a successor).
 */
import { ActorSuitesStore } from "./actor-suites.ts";
import { activityModelRole, modelContractFor } from "@shipbash/contracts/model-contract";
import { currentPromptContractVersion } from "@shipbash/contracts/prompt-contracts";
import type { SlackLineFacts } from "@shipbash/contracts/slack-line";
import type { SteerImage } from "@shipbash/contracts/steer-images";
import type {
  ActivityDetail,
  ActivityResultRecord,
  ActivitySummary,
  CreateActivityInput,
  TenantActor,
} from "../types.ts";
import {
  cancelActivity,
  getActivityDetail,
  listActivities,
  resumeActivityAfterAuth,
} from "./activities.ts";
import { lockProposalForNewWalk } from "./edit-walks.ts";
import { createActivityTransaction } from "./activity-transactions.ts";
import { nonEmpty, normalizeLimit } from "./normalize.ts";
import type { ActivityRow } from "./rows.ts";
import { ActivityNotRetryableError, retryableActivity } from "./activity-retry.ts";
import { requestActivityWrapUp } from "./activity-wrap-up.ts";
import {
  type ActivityAnswer,
  answerActivityQuestion,
  type PendingActivityQuestion,
  pendingActivityQuestion,
  steerActivity,
  unansweredActivityQuestion,
} from "./activity-interaction.ts";

export class ActorActivitiesStore extends ActorSuitesStore {
  async listActivities(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    limit?: number,
  ): Promise<ActivitySummary[]> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedLimit = normalizeLimit(limit);
    return this.withActor(actor, async (sql) => listActivities(sql, actor, scopedTeamId, scopedProjectId, scopedLimit));
  }

  async getActivityDetail(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    activityId: string,
  ): Promise<ActivityDetail | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedActivityId = nonEmpty(activityId, "activityId");
    return this.withActor(actor, async (sql) => getActivityDetail(sql, actor, scopedTeamId, scopedProjectId, scopedActivityId));
  }

  async createActivity(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    input: CreateActivityInput,
  ): Promise<ActivitySummary> {
    return this.withProjectRole(actor, teamId, projectId, "member", async (sql) => {
      return createActivityTransaction(sql, actor, {
        teamId: nonEmpty(teamId, "teamId"),
        projectId: nonEmpty(projectId, "projectId"),
        input,
        sourceActivityId: null,
        generation: 1,
      });
    });
  }

  async cancelActivity(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    activityId: string,
    summary = "Activity canceled.",
  ): Promise<ActivityResultRecord> {
    return this.withProjectRole(actor, teamId, projectId, "member", async (sql) => {
      return cancelActivity(sql, teamId, projectId, activityId, summary);
    });
  }

  async resumeActivityAfterAuth(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    activityId: string,
  ): Promise<void> {
    await this.withProjectRole(actor, teamId, projectId, "member", async (sql) => {
      await resumeActivityAfterAuth(sql, teamId, projectId, activityId);
    });
  }

  /** A message to the run, on the record for its leg to fold, and the bell
   * for a sleeping one (store/activity-interaction.ts); true when it woke it. */
  async steerActivity(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    activityId: string,
    steer: { message: string; clientKey: string; author?: string; images?: readonly SteerImage[]; slack?: SlackLineFacts },
  ): Promise<boolean> {
    return this.withProjectRole(actor, teamId, projectId, "member", async (sql) => {
      return steerActivity(sql, { teamId, projectId, activityId, ...steer });
    });
  }

  /** The question the run is waiting on, from its record. */
  async pendingActivityQuestion(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    activityId: string,
  ): Promise<PendingActivityQuestion | null> {
    return this.withProjectRole(actor, teamId, projectId, "member", async (sql) => {
      return pendingActivityQuestion(sql, { teamId, projectId, activityId });
    });
  }

  /** The question the Activity waits on that no answer was sent for yet. */
  async unansweredActivityQuestion(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    activityId: string,
  ): Promise<PendingActivityQuestion | null> {
    return this.withProjectRole(actor, teamId, projectId, "member", async (sql) => {
      return unansweredActivityQuestion(sql, { teamId, projectId, activityId });
    });
  }

  /** The owner's answer, remembered as knowledge and on the record for the leg to deliver. */
  async answerActivityQuestion(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    activityId: string,
    question: PendingActivityQuestion,
    answer: ActivityAnswer,
  ): Promise<void> {
    await this.withProjectRole(actor, teamId, projectId, "member", async (sql) => {
      await answerActivityQuestion(sql, { teamId, projectId, activityId }, question, answer);
    });
  }

  /** The owner's Stop: on the record for the leg's heartbeat to deliver and
   * the console to show; true when this call was the one that recorded it. */
  async requestActivityWrapUp(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    activityId: string,
  ): Promise<boolean> {
    return this.withProjectRole(actor, teamId, projectId, "member", async (sql) => {
      return requestActivityWrapUp(sql, { teamId, projectId, activityId });
    });
  }

  async retryActivity(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    sourceActivityId: string,
    clientIdempotencyKey: string,
    dispatchIdentity: CreateActivityInput["dispatchIdentity"],
  ): Promise<ActivitySummary> {
    return this.withProjectRole(actor, teamId, projectId, "member", async (sql) => {
      const rows = await sql<Array<ActivityRow & {
        protected_input: string | null;
        source_proposal_id: string | null;
      }>>`
        select id, team_id, project_id, kind, protected_input, source_proposal_id,
          trigger_source, status, source_activity_id, generation, repository_id,
          repository_commit_sha, prompt_contract_version,
          created_at, updated_at, started_at, completed_at
        from public.activities
        where id = ${nonEmpty(sourceActivityId, "sourceActivityId")}::uuid
          and team_id = ${nonEmpty(teamId, "teamId")}::uuid
          and project_id = ${nonEmpty(projectId, "projectId")}
        for share
      `;
      const source = rows[0];
      if (!source) throw new Error("Activity not found.");
      if (!retryableActivity(source.status)) throw new ActivityNotRetryableError(source.status);
      // A retried walk of a proposal (an edit walk of a staging draft, a
      // follow-up walk of drafts) is another walk of it, under the same rules.
      if (source.source_proposal_id) {
        await lockProposalForNewWalk(sql, actor, {
          teamId: source.team_id,
          projectId: source.project_id,
          draftId: source.source_proposal_id,
          clientIdempotencyKey,
        });
      }
      return createActivityTransaction(sql, actor, {
        teamId: source.team_id,
        projectId: source.project_id,
        sourceActivityId: source.id,
        generation: source.generation + 1,
        input: {
          kind: source.kind,
          // No initialMessage: the source's steer_requested events stay owed
          // to this retry via listUndeliveredActivitySteers' lineage union.
          protectedInput: source.protected_input,
          // A retried edit walk walks the same staging draft again.
          sourceProposalId: source.source_proposal_id,
          triggerSource: "retry",
          clientIdempotencyKey: nonEmpty(clientIdempotencyKey, "clientIdempotencyKey"),
          semanticExecutionKey: null,
          // The source's commit only with the binding it was read from: once
          // that binding is replaced the retry takes the new one's last read.
          repositoryId: source.repository_id,
          repositoryCommitSha: source.repository_id ? source.repository_commit_sha : null,
          // A retry runs with today's configuration: inheriting the source's
          // contract version would pin the new attempt to a superseded
          // contract the runtime refuses to resolve.
          promptContractVersion: currentPromptContractVersion(source.kind),
          modelContract: modelContractFor(activityModelRole(source.kind)),
          dispatchIdentity,
        },
      });
    });
  }
}
