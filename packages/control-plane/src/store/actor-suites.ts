/**
 * Actor facet — Suites and Proposals: suite listings and revisions, the
 * seed-account auth profile read, and the proposal lifecycle.
 */
import { ActorSlackStore } from "./actor-slack.ts";
import type { TargetAuthProfileStatus } from "@shipbash/contracts/database-contract-types";
import type {
  ActivitySummary,
  CreateActivityInput,
  DispatchIdentityInput,
  MutableSuiteCaseInput,
  RunDispatchResult,
  SuiteDefinitionSaveResult,
  SuiteDetail,
  SuiteProposal,
  SuiteSummary,
  TenantActor,
} from "../types.ts";
import { type DraftsKept, keepDraftsTransaction, verifyKeptDraftsTransaction } from "./draft-keep.ts";
import { type EditWalk, latestEditWalks, startEditWalkTransaction, startFollowUpWalkTransaction } from "./edit-walks.ts";
import { type JourneyEditKept, keepJourneyEditTransaction } from "./journey-edit-keep.ts";
import { stageJourneyEditTransaction } from "./journey-edit-staging.ts";
import {
  nonEmpty,
  normalizeCaseInputs,
  normalizeLimit,
  timestamp,
} from "./normalize.ts";
import {
  getProposal,
  listInitialProposalIds,
  listProposals,
  rejectProposal,
} from "./proposals.ts";
import { normalizeDispatchScope } from "./run-dispatch.ts";
import { saveSuiteDefinitionGuarded } from "./suite-definition-save.ts";
import { getSuiteDetail, listSuiteSummaries } from "./suites.ts";
import { getProjectAuthProfile } from "./target-auth-profiles.ts";

export class ActorSuitesStore extends ActorSlackStore {
  /** The seed account's health for this project, or null before first setup. */
  async getProjectAuthProfile(
    actor: TenantActor,
    teamId: string,
    projectId: string,
  ): Promise<{
    status: TargetAuthProfileStatus;
    productionOrigin: string;
    lastVerifiedAt: string | null;
    failureReason: string | null;
  } | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    return this.withActor(actor, async (sql) => getProjectAuthProfile(sql, actor, scopedTeamId, scopedProjectId));
  }

  async listSuiteSummaries(
    actor: TenantActor,
    teamId: string,
    projectId: string,
  ): Promise<SuiteSummary[]> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    return this.withActor(actor, async (sql) => listSuiteSummaries(sql, actor, scopedTeamId, scopedProjectId));
  }

  async getSuiteDetail(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    suiteId: string,
  ): Promise<SuiteDetail | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedSuiteId = nonEmpty(suiteId, "suiteId");
    return this.withActor(actor, async (sql) => getSuiteDetail(sql, actor, scopedTeamId, scopedProjectId, scopedSuiteId));
  }

  async saveManualSuiteRevision(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    suiteId: string,
    input: {
      expectedRevision: number;
      name: string;
      cases: readonly MutableSuiteCaseInput[];
    },
  ): Promise<SuiteDefinitionSaveResult> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedSuiteId = nonEmpty(suiteId, "suiteId");
    const normalizedCases = normalizeCaseInputs(input.cases);
    return this.withProjectRole(actor, scopedTeamId, scopedProjectId, "member", async (sql) => {
      return saveSuiteDefinitionGuarded(sql, actor, {
        teamId: scopedTeamId,
        projectId: scopedProjectId,
        suiteId: scopedSuiteId,
        expectedRevision: input.expectedRevision,
        name: input.name,
        cases: normalizedCases,
        source: "manual",
        sourceRef: null,
      });
    });
  }

  /** Stages one case's edit onto the suite's single journey-edit draft. */
  async stageJourneyEdit(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    suiteId: string,
    caseId: string,
    input: { instruction: string; case: MutableSuiteCaseInput; expectedRevision: number },
  ): Promise<SuiteProposal> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedSuiteId = nonEmpty(suiteId, "suiteId");
    const scopedCaseId = nonEmpty(caseId, "caseId");
    const instruction = input.instruction.trim();
    if (instruction.length > 2_000) throw new Error("instruction exceeds 2000 characters.");
    const [stagedCase] = normalizeCaseInputs([{ ...input.case, id: scopedCaseId }]);
    if (!stagedCase) throw new Error("The staged Case did not normalize.");
    return this.withProjectRole(actor, scopedTeamId, scopedProjectId, "member", async (sql) => {
      return stageJourneyEditTransaction(sql, actor, {
        teamId: scopedTeamId,
        projectId: scopedProjectId,
        suiteId: scopedSuiteId,
        caseId: scopedCaseId,
        expectedRevision: input.expectedRevision,
        instruction,
        stagedCase,
      });
    });
  }

  /** Starts a walk of the staging draft as the caller read it, under the draft's lock. */
  async startEditWalk(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    draftId: string,
    input: { expectedUpdatedAt: string; activity: CreateActivityInput },
  ): Promise<ActivitySummary> {
    const scope = {
      teamId: nonEmpty(teamId, "teamId"),
      projectId: nonEmpty(projectId, "projectId"),
      draftId: nonEmpty(draftId, "draftId"),
      expectedUpdatedAt: timestamp(input.expectedUpdatedAt, "expectedUpdatedAt"),
    };
    return this.withProjectRole(actor, scope.teamId, scope.projectId, "member", async (sql) => {
      return startEditWalkTransaction(sql, actor, { ...scope, activity: input.activity, runQuota: this.runQuota });
    });
  }

  /**
   * Starts a walk that revises a proposal's drafts, under the proposal's
   * lock; `continues` names the walk it continues (a Discovery's lineage).
   */
  async startFollowUpWalk(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    proposalId: string,
    input: { activity: CreateActivityInput; continues: string | null },
  ): Promise<ActivitySummary> {
    const scope = {
      teamId: nonEmpty(teamId, "teamId"),
      projectId: nonEmpty(projectId, "projectId"),
      draftId: nonEmpty(proposalId, "proposalId"),
    };
    return this.withProjectRole(actor, scope.teamId, scope.projectId, "member", async (sql) => {
      return startFollowUpWalkTransaction(sql, actor, { ...scope, ...input });
    });
  }

  /** Keeps what the reviewed walk of the staging draft proved and retires the draft. */
  async keepJourneyEdit(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    draftId: string,
    decision: { walkId: string; expectedUpdatedAt: string },
  ): Promise<JourneyEditKept> {
    const input = {
      teamId: nonEmpty(teamId, "teamId"),
      projectId: nonEmpty(projectId, "projectId"),
      draftId: nonEmpty(draftId, "draftId"),
      walkId: nonEmpty(decision.walkId, "walkId"),
      expectedUpdatedAt: timestamp(decision.expectedUpdatedAt, "expectedUpdatedAt"),
    };
    return this.withProjectRole(actor, input.teamId, input.projectId, "member", async (sql) => {
      return keepJourneyEditTransaction(sql, actor, input);
    });
  }

  /** The latest walk of each named staging draft. */
  async latestEditWalks(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    draftIds: readonly string[],
  ): Promise<Map<string, EditWalk>> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    return this.withActor(actor, async (sql) => latestEditWalks(sql, scopedTeamId, scopedProjectId, draftIds));
  }

  async listProposals(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    limit?: number,
  ): Promise<SuiteProposal[]> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedLimit = normalizeLimit(limit);
    return this.withActor(actor, async (sql) => listProposals(sql, actor, scopedTeamId, scopedProjectId, scopedLimit));
  }

  async getProposal(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    proposalId: string,
  ): Promise<SuiteProposal | null> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    const scopedProposalId = nonEmpty(proposalId, "proposalId");
    return this.withActor(actor, async (sql) => getProposal(sql, actor, scopedTeamId, scopedProjectId, scopedProposalId));
  }

  async listInitialProposalIds(
    actor: TenantActor,
    teamId: string,
    projectId: string,
  ): Promise<string[]> {
    const scopedTeamId = nonEmpty(teamId, "teamId");
    const scopedProjectId = nonEmpty(projectId, "projectId");
    return this.withActor(actor, async (sql) => listInitialProposalIds(sql, actor, scopedTeamId, scopedProjectId));
  }

  /** Discards the proposal; given the version the reader decided on, only while it is that version. */
  async rejectProposal(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    proposalId: string,
    decision?: { expectedUpdatedAt: string },
  ): Promise<SuiteProposal> {
    const expectedUpdatedAt = decision ? timestamp(decision.expectedUpdatedAt, "expectedUpdatedAt") : null;
    return this.withProjectRole(actor, teamId, projectId, "member", async (sql) => {
      return rejectProposal(sql, actor, { teamId, projectId, proposalId }, expectedUpdatedAt);
    });
  }

  /** Keeps the drafts the reader chose, as the walk delivered them (draft-keep.ts). */
  async keepDrafts(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    proposalId: string,
    decision: { expectedUpdatedAt: string; keep: string[] | null },
  ): Promise<DraftsKept> {
    const input = {
      teamId: nonEmpty(teamId, "teamId"),
      projectId: nonEmpty(projectId, "projectId"),
      proposalId: nonEmpty(proposalId, "proposalId"),
      expectedUpdatedAt: timestamp(decision.expectedUpdatedAt, "expectedUpdatedAt"),
      keep: decision.keep,
    };
    return this.withProjectRole(actor, input.teamId, input.projectId, "member", async (sql) => {
      return keepDraftsTransaction(sql, actor, input);
    });
  }

  /** Starts the verification of what a keep landed, if a run walks any of it; a retry is answered with the run it started. */
  async verifyKeptDrafts(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    proposalId: string,
    dispatch: DispatchIdentityInput,
  ): Promise<RunDispatchResult | null> {
    const scope = normalizeDispatchScope(teamId, projectId, dispatch, this.runQuota);
    return this.withProjectRole(actor, scope.teamId, scope.projectId, "member", async (sql) => {
      return verifyKeptDraftsTransaction(sql, actor, scope, nonEmpty(proposalId, "proposalId"));
    });
  }
}
