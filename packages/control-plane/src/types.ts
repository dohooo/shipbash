import type {
  CaseVerdict,
  GitHubAccountType,
  GitHubInstallationStatus,
  ProjectLifecycleStatus,
  ProjectRepositoryAccessStatus,
  ProjectTrustedAccessMode,
  ProjectTrustedAccessStatus,
  ProposalKind,
  ProposalStatus,
  RunVerdict,
  SuiteCaseOrigin,
  SuiteCaseRepeat,
  SuiteCaseRole,
  SuiteDefinitionRevisionSource,
  SuiteLifecycleStatus,
  TeamInvitationStatus,
  TeamRole,
} from "@shipbash/contracts/database-contract-types";
import type { JourneyCheckpoint, JourneyCheckpointInput, JourneyStep, JourneyStepInput } from "@shipbash/contracts/journey-contracts";
import type { AgentRuntime } from "@shipbash/contracts/model-contract";
import type { OwnerConfirmation } from "@shipbash/contracts/runtime/case-role-contract.mjs";

export type {
  ActivityKind,
  ActivityStatus,
  CaseVerdict,
  GitHubAccountType,
  GitHubInstallationStatus,
  ProjectLifecycleStatus,
  ProjectRepositoryAccessStatus,
  ProjectTrustedAccessMode,
  ProjectTrustedAccessStatus,
  ProposalKind,
  ProposalStatus,
  RunVerdict,
  SuiteCaseOrigin,
  SuiteCaseRepeat,
  SuiteCaseRole,
  SuiteDefinitionRevisionSource,
  SuiteLifecycleStatus,
  TeamInvitationStatus,
  TeamRole,
} from "@shipbash/contracts/database-contract-types";
export type * from "@shipbash/contracts/execution-types";
export type * from "@shipbash/contracts/schedule-types";

import type { SuiteSchedule } from "@shipbash/contracts/schedule-types";
export interface TenantActor {
  userId: string;
}

/** The job a job API call is served for, as its row names it: never as the caller does. */
export interface JobScope {
  id: string;
  kind: "suite_run" | "activity";
  teamId: string;
  projectId: string;
  activityId: string | null;
  suiteRunId: string | null;
}

/** Who an account is to its teammates: a GitHub login, an email, or both. */
export interface ProfileIdentity {
  userId: string;
  displayName: string;
  githubUserId: number | null;
  githubLogin: string | null;
  avatarUrl: string | null;
  email: string | null;
}

/** The signed-in account: who it is, and where an address that names no team opens. */
export interface CurrentUser {
  profile: ProfileIdentity;
  /** Its default team while it is still in it; null leaves the choice to the first of its teams. */
  defaultTeamId: string | null;
}

export interface UserProfile extends ProfileIdentity {
  createdAt: string;
  updatedAt: string;
}

export interface Team {
  id: string;
  /** The team's segment in a URL: derived from the name once, then stable. */
  slug: string;
  name: string;
  role: TeamRole;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMember extends UserProfile {
  teamId: string;
  role: TeamRole;
  membershipCreatedAt: string;
}

export interface TeamInvitation {
  id: string;
  teamId: string;
  invitedGithubUserId: number;
  invitedGithubLogin: string;
  status: TeamInvitationStatus;
  createdBy: string;
  acceptedBy: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** One GitHub account a team connected: waiting for an owner, reading, or revoked on GitHub. */
export interface GitHubInstallation {
  id: string;
  teamId: string;
  /** Null only while an organization owner has not approved the install. */
  installationId: number | null;
  githubAccountId: number;
  githubAccountLogin: string;
  accountType: GitHubAccountType;
  status: GitHubInstallationStatus;
  /** Who connected it, as the team knows them. */
  installedBy: string | null;
  createdAt: string;
  connectedAt: string | null;
  revokedAt: string | null;
}

/** A redirect in flight to GitHub: the hash of its one-shot state, and who may redeem it. */
export interface GitHubRedirectState {
  stateHash: string;
  teamId: string;
  userId: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
  /** The origin that issued the redirect, when it was not this deployment's; a preview finishes its own installs. */
  returnOrigin: string | null;
}

/** An install redirect, which always knows the pane it returns to. */
/** What GitHub's setup redirect was: an install (or a change to one) naming its installation, or a request. */
export type GitHubSetup = { kind: "install"; installationId: number } | { kind: "request" };

export interface GitHubInstallationState extends GitHubRedirectState {
  returnPath: string;
  /** What GitHub's setup redirect recorded on the state; null until it arrives. */
  setup: GitHubSetup | null;
}

export interface GitHubInstallationInput {
  installationId: number;
  githubAccountId: number;
  githubAccountLogin: string;
  accountType: GitHubAccountType;
}

export interface TenantProject {
  id: string;
  teamId: string;
  /** The product's segment in a URL, unique within its team. */
  slug: string;
  name: string;
  productionUrl: string | null;
  testingContext: string | null;
  /** The Agent runtime new Discovery and Verification work inherits. */
  agentRuntime: AgentRuntime;
  lifecycleStatus: ProjectLifecycleStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTrustedAccess {
  projectId: string;
  teamId: string;
  mode: ProjectTrustedAccessMode;
  headerName: string;
  status: ProjectTrustedAccessStatus;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRepository {
  id: string;
  teamId: string;
  projectId: string;
  githubInstallationId: string;
  githubRepositoryId: number;
  ownerLogin: string;
  repositoryName: string;
  defaultBranch: string;
  selectedCommitSha: string | null;
  accessStatus: ProjectRepositoryAccessStatus;
  lastReadAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A repository as one read found it: GitHub's names for it now, and its default branch head. */
export interface GitHubRead {
  repository: { id: number; owner: string; name: string; defaultBranch: string };
  commitSha: string;
}

/** The repository one project reads, through one of the team's connections. */
export interface GitHubBinding {
  id: string;
  projectId: string;
  projectName: string;
  connectionId: string;
  installationId: number | null;
  repository: GitHubRead["repository"];
  commitSha: string | null;
  lastReadAt: string | null;
  accessStatus: ProjectRepositoryAccessStatus;
}

export interface SuiteCaseDefinition {
  id?: string;
  title: string;
  steps: JourneyStep[];
  category: string;
  checkpoints: JourneyCheckpoint[];
  whyItMatters: string | null;
  /** Absent on agent/wire candidates — an empty list means "not carried", never "cleared". */
  preconditions?: string[];
  /** Absent on a candidate written before hooks: a repeatable Journey. */
  role?: SuiteCaseRole;
  scopeCaseId?: string | null;
  repeat?: SuiteCaseRepeat;
  ownerConfirmation?: OwnerConfirmation;
  enabled?: boolean;
  archived?: boolean;
}

export interface DurableSuite {
  id: string;
  teamId: string;
  projectId: string;
  name: string;
  definitionRevision: number;
  lifecycleStatus: SuiteLifecycleStatus;
  productThesis: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DurableSuiteCase {
  id: string;
  teamId: string;
  projectId: string;
  suiteId: string;
  position: number;
  title: string;
  steps: JourneyStep[];
  category: string;
  checkpoints: JourneyCheckpoint[];
  whyItMatters: string | null;
  /** What the environment must already provide for the walk to be fair. */
  preconditions: string[];
  /** A Journey, or a setup/teardown hook around the run; a per-journey hook names its Journey. */
  role: SuiteCaseRole;
  scopeCaseId: string | null;
  repeat: SuiteCaseRepeat;
  enabled: boolean;
  archivedAt: string | null;
  origin: SuiteCaseOrigin;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SuiteCaseResult {
  runId: string;
  isPublic: boolean;
  caseRunId: string;
  verdict: CaseVerdict | null;
  runAt: string;
  durationMs: number | null;
}

export interface SuiteCaseDetail extends DurableSuiteCase {
  latestVerdict: CaseVerdict | null;
  latestRunAt: string | null;
  /** The last verified walk ran an older revision of this script. */
  verificationState: "verified" | "unverified";
  /** Up to the last seven case results, oldest first. */
  recentResults: SuiteCaseResult[];
}

export interface SuiteSummary extends DurableSuite {
  activeCaseCount: number;
  latestVerdict: RunVerdict | null;
  latestRunAt: string | null;
}

export interface SuiteDetail {
  suite: SuiteSummary;
  cases: SuiteCaseDetail[];
  schedule: SuiteSchedule | null;
}

export interface SuiteDefinitionRevision {
  id: string;
  teamId: string;
  projectId: string;
  suiteId: string;
  revision: number;
  definition: SuiteCaseDefinition[];
  source: SuiteDefinitionRevisionSource;
  sourceRef: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface SuiteDefinitionSaveResult {
  suite: DurableSuite;
  revision: SuiteDefinitionRevision;
  cases: DurableSuiteCase[];
}

export interface MutableSuiteCaseInput {
  id?: string | undefined;
  title: string;
  steps: string | JourneyStepInput[];
  category: string;
  checkpoints: JourneyCheckpointInput[];
  whyItMatters?: string | null | undefined;
  /** What the environment must already provide for the walk to be fair. */
  preconditions?: readonly string[] | undefined;
  role?: SuiteCaseRole | undefined;
  scopeCaseId?: string | null | undefined;
  scopeCandidateIndex?: number | null | undefined;
  repeat?: SuiteCaseRepeat | undefined;
  ownerConfirmation?: OwnerConfirmation | undefined;
  enabled?: boolean | undefined;
  archived?: boolean | undefined;
}

export interface SuiteProposal {
  id: string;
  /** Verified Activity named by an activity-job trigger, when this draft came from discovery. */
  sourceActivityId?: string | null;
  /**
   * The staging draft this proposal is an edit walk's result for, read with
   * the proposal list and a proposal by id; null on every other proposal.
   */
  editWalkDraftId?: string | null;
  teamId: string;
  projectId: string;
  kind: ProposalKind;
  targetSuiteId: string | null;
  appliedSuiteId: string | null;
  baseDefinitionRevision: number | null;
  proposedSuiteName: string | null;
  productThesis: string | null;
  candidateDefinition: SuiteCaseDefinition[];
  status: ProposalStatus;
  repositoryCommitSha: string | null;
  promptContractVersion: string;
  /**
   * Staged journey-edit instructions keyed by case id, parsed from the
   * trigger. Optional: absent (and truthfully null) on read paths that
   * cannot see a journey-edit staging draft and never fetch the trigger.
   */
  journeyEditInstructions?: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
}

export type ProposalApplyResult =
  | {
      outcome: "applied";
      proposalId: string;
      suiteId: string;
      revision: number;
    }
  | {
      outcome: "superseded";
      proposalId: string;
      suiteId: string;
      currentRevision: number;
    };
