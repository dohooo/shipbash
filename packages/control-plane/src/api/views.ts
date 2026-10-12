/**
 * Read-model shaping: every JSON view the API returns is built here, so
 * the wire format lives in one place and route handlers stay imperative.
 */

import { TERMINAL_ACTIVITY_STATUS_VALUES } from "@shipbash/contracts/activity-lifecycle";
import type {
  ActivityEventView,
  ActivityView,
  ProjectTrustedAccessView,
  ProjectView,
  ProposalView,
  ScheduleView,
  SuiteDetailView,
} from "@shipbash/contracts/api/view-types";
import type { AgentRuntime } from "@shipbash/contracts/model-contract";
import { boundedSafeData, safeDataFieldLimit } from "@shipbash/contracts/runtime/activity-safe-data.mjs";
import { redactActivityRuntimeValue } from "../activity-runtime.ts";
import type { ActorStore } from "../store/actor-store.ts";
import type { EditWalk } from "../store/edit-walks.ts";
import { draftCaseIds, unchangedCandidateIds } from "../draft-review.ts";
import type { ActivitySummary, DurableSuiteCase, ProjectRepository, ProjectTrustedAccess, TenantActor, TenantProject } from "../types.ts";

export * from "@shipbash/contracts/api/view-types";
export * from "./run-views.ts";

import type { StoreActivity, StoreActivityDetail, StoreProposal, StoreSuiteDetail } from "./gateways.ts";

export function scheduleView(schedule: StoreSuiteDetail["schedule"]): ScheduleView | null {
  if (!schedule) return null;
  return {
    cadence: schedule.cadence,
    localTime: schedule.localTime,
    cronExpression: schedule.cronExpression,
    timezone: schedule.timezone,
    nextRunAt: schedule.nextRunAt,
    lastSkippedAt: schedule.lastSkippedAt,
    lastSkipReason: schedule.lastSkipReason,
  };
}

export function suiteDetailView(detail: StoreSuiteDetail): SuiteDetailView {
  const activeCases = detail.cases.filter((entry) => !entry.archivedAt);
  return {
    id: detail.suite.id,
    name: detail.suite.name,
    caseCount: activeCases.length,
    enabledCaseCount: activeCases.filter((entry) => entry.enabled).length,
    definitionRevision: detail.suite.definitionRevision,
    lifecycleStatus: detail.suite.lifecycleStatus,
    productThesis: detail.suite.productThesis,
    latestVerdict: detail.suite.latestVerdict,
    latestRunAt: detail.suite.latestRunAt,
    updatedAt: detail.suite.updatedAt,
    schedule: scheduleView(detail.schedule),
    cases: detail.cases.map((entry) => ({
      id: entry.id,
      title: entry.title,
      steps: entry.steps,
      category: entry.category,
      checkpoints: entry.checkpoints,
      whyItMatters: entry.whyItMatters,
      preconditions: entry.preconditions,
      role: entry.role,
      scopeCaseId: entry.scopeCaseId,
      repeat: entry.repeat,
      origin: entry.origin,
      enabled: entry.enabled,
      archived: entry.archivedAt !== null,
      position: entry.position,
      latestVerdict: entry.latestVerdict,
      latestRunAt: entry.latestRunAt,
      verificationState: entry.verificationState,
      recentResults: entry.recentResults,
    })),
  };
}

export function activityView(activity: StoreActivity): ActivityView {
  const resultLabel =
    activity.status === "completed"
      ? "Completed"
      : activity.status === "needs_attention"
        ? "Needs attention"
        : activity.status === "waiting_for_auth"
          ? "Waiting for auth"
          : activity.status === "waiting_for_input"
            ? "Waiting for you"
            : null;
  return {
    id: activity.id,
    kind: activity.kind,
    triggerSource: activity.triggerSource,
    status: activity.status,
    resultLabel,
    sourceActivityId: activity.sourceActivityId ?? null,
    updatedAt: activity.updatedAt,
  };
}

export const terminalActivityStatuses = new Set<ActivitySummary["status"]>(TERMINAL_ACTIVITY_STATUS_VALUES);
// This hop's own censoring list — it alone censors object-path keys, and it
// lacks the host parser's credential/passwd terms.
const sensitiveActivityDataKey = /authorization|cookie|password|secret|token|object.?path/iu;

export function activityEventView(event: StoreActivityDetail["events"][number]): ActivityEventView {
  const safeData = boundedSafeData(event.safeData, {
    sensitiveKeyPattern: sensitiveActivityDataKey,
    // faviconDataUrl skips the redactor: a data: URL never carries a secret
    // this hop could name, and the redactor's default 4,000-character cap
    // would otherwise eat it (the same cap silently bounds *Json fields to
    // 4,000 despite the contract's 8,000).
    transformString: (value, key) =>
      key === "faviconDataUrl" ? value.slice(0, 24_000) : String(redactActivityRuntimeValue(value)).slice(0, safeDataFieldLimit(key)),
  });
  return {
    id: event.id.slice(0, 200),
    sequence: event.sequence,
    kind: event.kind,
    label: String(redactActivityRuntimeValue(event.label)).slice(0, 500),
    bodyMarkdown: event.bodyMarkdown ? String(redactActivityRuntimeValue(event.bodyMarkdown)).slice(0, 20_000) : null,
    safeData,
    createdAt: event.createdAt,
  };
}

export function projectView(
  project: {
    id: string;
    teamId: string;
    slug: string;
    name: string;
    productionUrl: string | null;
    testingContext: string | null;
    agentRuntime: AgentRuntime;
    lifecycleStatus: TenantProject["lifecycleStatus"];
  },
  repository: {
    id: string;
    githubRepositoryId: number;
    ownerLogin: string;
    repositoryName: string;
    defaultBranch: string;
    selectedCommitSha: string | null;
    accessStatus: ProjectRepository["accessStatus"];
  } | null,
): ProjectView {
  return {
    id: project.id,
    teamId: project.teamId,
    slug: project.slug,
    name: project.name,
    productionUrl: project.productionUrl,
    testingContext: project.testingContext,
    agentRuntime: project.agentRuntime,
    lifecycleStatus: project.lifecycleStatus,
    repository: repository
      ? {
          id: repository.id,
          githubRepositoryId: repository.githubRepositoryId,
          ownerLogin: repository.ownerLogin,
          repositoryName: repository.repositoryName,
          defaultBranch: repository.defaultBranch,
          selectedCommitSha: repository.selectedCommitSha,
          accessStatus: repository.accessStatus,
        }
      : null,
  };
}

export function projectTrustedAccessView(access: ProjectTrustedAccess): ProjectTrustedAccessView {
  return {
    projectId: access.projectId,
    teamId: access.teamId,
    mode: access.mode,
    headerName: access.headerName,
    status: access.status,
    lastVerifiedAt: access.lastVerifiedAt,
    createdAt: access.createdAt,
    updatedAt: access.updatedAt,
  };
}

/** What labelling a Proposal needs beyond its own row. */
export interface ProposalViewInputs {
  suiteNames: ReadonlyMap<string, string>;
  initialIds: ReadonlySet<string>;
  /** The live Cases of every Suite a change_suite Proposal in view targets, by Suite id. */
  liveCases: ReadonlyMap<string, readonly DurableSuiteCase[]>;
  /** The latest edit walk of each staging draft in view, by draft id. */
  editWalks: ReadonlyMap<string, EditWalk>;
}

/** The latest walk of each staging draft among the Proposals; no read when there is none. */
export async function loadEditWalks(
  store: Pick<ActorStore, "latestEditWalks">,
  actor: TenantActor,
  teamId: string,
  projectId: string,
  proposals: readonly StoreProposal[],
): Promise<ReadonlyMap<string, EditWalk>> {
  const drafts = proposals.flatMap((proposal) => (proposal.journeyEditInstructions ? [proposal.id] : []));
  return drafts.length ? store.latestEditWalks(actor, teamId, projectId, drafts) : new Map();
}

/** Suite names by id, the label a Run or a Proposal shows for its Suite. */
export function suiteNameMap(summaries: readonly { id: string; name: string }[]): Map<string, string> {
  return new Map(summaries.map((entry) => [entry.id, entry.name]));
}

/**
 * Loads the labelling inputs for the given Proposals: Suite names, the
 * initial-proposal scan, the live Cases of each targeted Suite, and the
 * latest walk of each staging draft.
 */
export async function loadProposalViewInputs(
  store: Pick<ActorStore, "listSuiteSummaries" | "getSuiteDetail" | "listInitialProposalIds" | "latestEditWalks">,
  actor: TenantActor,
  teamId: string,
  projectId: string,
  proposals: readonly StoreProposal[],
): Promise<ProposalViewInputs> {
  const targeted = [...new Set(proposals.flatMap((proposal) => (proposal.targetSuiteId ? [proposal.targetSuiteId] : [])))];
  const [suites, initialIds, details, editWalks] = await Promise.all([
    store.listSuiteSummaries(actor, teamId, projectId),
    initialProposalIds(store, actor, teamId, projectId),
    Promise.all(targeted.map((suiteId) => store.getSuiteDetail(actor, teamId, projectId, suiteId))),
    loadEditWalks(store, actor, teamId, projectId, proposals),
  ]);
  return {
    suiteNames: suiteNameMap(suites),
    initialIds,
    liveCases: new Map(details.flatMap((detail) => (detail ? [[detail.suite.id, detail.cases] as const] : []))),
    editWalks,
  };
}

/** The inputs for a view with no Proposals to label. */
export function emptyProposalViewInputs(): ProposalViewInputs {
  return { suiteNames: new Map(), initialIds: new Set(), liveCases: new Map(), editWalks: new Map() };
}

/** The ids of the live Cases of the Suite a proposal targets. */
export function liveCaseIds(proposal: StoreProposal, inputs: ProposalViewInputs): Set<string> {
  const live = proposal.targetSuiteId ? (inputs.liveCases.get(proposal.targetSuiteId) ?? []) : [];
  return new Set(live.filter((suiteCase) => suiteCase.archivedAt === null).map((suiteCase) => suiteCase.id));
}

/** The candidates the review shows as approved, not as drafts (draft-review.ts). */
export function unchangedCaseIds(proposal: StoreProposal, inputs: ProposalViewInputs): string[] {
  const live = (proposal.targetSuiteId ? (inputs.liveCases.get(proposal.targetSuiteId) ?? []) : [])
    .map((suiteCase) => ({ ...suiteCase, archived: suiteCase.archivedAt !== null }));
  return unchangedCandidateIds(proposal, live, inputs.initialIds.has(proposal.id));
}

export function proposalView(proposal: StoreProposal, inputs: ProposalViewInputs): ProposalView {
  const unchanged = unchangedCaseIds(proposal, inputs);
  return {
    id: proposal.id,
    sourceActivityId: proposal.sourceActivityId ?? null,
    kind: proposal.kind,
    status: proposal.status,
    targetSuiteId: proposal.targetSuiteId,
    targetSuiteName: proposal.targetSuiteId ? (inputs.suiteNames.get(proposal.targetSuiteId) ?? null) : null,
    proposedSuiteName: proposal.proposedSuiteName,
    baseDefinitionRevision: proposal.baseDefinitionRevision,
    productThesis: proposal.productThesis,
    candidateDefinition: proposal.candidateDefinition,
    action: inputs.initialIds.has(proposal.id) ? "confirm_and_run" : proposal.kind === "create_suite" ? "create_suite" : "apply_changes",
    journeyEditInstructions: proposal.journeyEditInstructions ?? null,
    unchangedCaseIds: unchanged,
    // A staging draft is kept whole, by the walk that verified it.
    draftCaseIds: proposal.journeyEditInstructions ? [] : draftCaseIds(proposal, unchanged, liveCaseIds(proposal, inputs)),
    walk: inputs.editWalks.get(proposal.id) ?? null,
    editWalkDraftId: proposal.editWalkDraftId ?? null,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
  };
}

export async function initialProposalIds(
  store: Pick<ActorStore, "listInitialProposalIds">,
  actor: TenantActor,
  teamId: string,
  projectId: string,
): Promise<Set<string>> {
  return new Set(await store.listInitialProposalIds(actor, teamId, projectId));
}
