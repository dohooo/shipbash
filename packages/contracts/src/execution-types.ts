// The records below are what a Run leaves behind; the page that reads them as
// one — the run, its family's latest attempts, the trail — is assembled in
// run-detail-types.ts and named here with them.
export type * from "./run-detail-types.ts";

import type { BrowserRecordingPlaybackMetadata } from "./browser-recording-playback.ts";
import type {
  ActivityAttentionCode,
  ActivityEventKind,
  ActivityKind,
  ActivityResultKind,
  ActivityStatus,
  ActivityTriggerSource,
  ArtifactKind,
  ArtifactStorageStatus,
  BrowserRecordingMimeType,
  BrowserRecordingStorageStatus,
  CaseRunStatus,
  CaseVerdict,
  DispatchJobKind,
  DispatchJobStatus,
  ReproducedRunCount,
  RunEventLevel,
  RunVerdict,
  SuiteCaseRepeat,
  SuiteCaseRole,
  SuiteRunFinalizationStatus,
  SuiteRunStatus,
  SuiteRunTriggerKind,
} from "./database-contract-types.ts";
import type { JourneyCheckpoint, JourneyStep } from "./journey-contracts.ts";

export type { ActivityEventKind } from "./database-contract-types.ts";
export type ChecklistTerminalStatus = "passed" | "failed" | "blocked" | "not_run";
export type ChecklistStatus = ChecklistTerminalStatus | "pending" | "in_progress";

export type CaseChecklistItem = {
  id: string;
  goal: string;
  status: ChecklistStatus;
  reason: string | null;
};

export interface SuiteRunSummary {
  id: string;
  teamId: string;
  projectId: string;
  suiteId: string | null;
  snapshotId: string;
  /** The run this one is an attempt of: a case retry's root, null on a root run. */
  sourceSuiteRunId: string | null;
  status: SuiteRunStatus;
  verdict: RunVerdict | null;
  finalizationStatus: SuiteRunFinalizationStatus;
  isPublic: boolean;
  triggerKind: SuiteRunTriggerKind | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunDispatchResult {
  run: SuiteRunSummary;
  snapshotId: string;
  dispatchJobId: string;
  created: boolean;
  reusedOutstanding: boolean;
}

export interface DispatchIdentityInput {
  idempotencyKey: string;
  identityHash: string;
  expiresAt: string;
  promptContractVersions: Record<string, string>;
  modelContract: Record<string, unknown>;
}

export interface ActivitySummary {
  id: string;
  teamId: string;
  projectId: string;
  kind: ActivityKind;
  triggerSource: ActivityTriggerSource;
  status: ActivityStatus;
  sourceActivityId: string | null;
  generation: number;
  repositoryId: string | null;
  repositoryCommitSha: string | null;
  promptContractVersion: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ActivityEvent {
  id: string;
  teamId: string;
  projectId: string;
  activityId: string;
  sequence: number;
  kind: ActivityEventKind;
  label: string;
  bodyMarkdown: string | null;
  safeData: Record<string, unknown>;
  createdAt: string;
}

export interface ActivityResultRecord {
  activityId: string;
  teamId: string;
  projectId: string;
  kind: ActivityResultKind;
  summary: string;
  attentionCode: ActivityAttentionCode | null;
  recoveryAction: string | null;
  proposalIds: string[];
  createdAt: string;
}

export interface ActivityDetail {
  activity: ActivitySummary;
  /** When the owner asked this leg to stop and deliver; cleared by a wake. */
  wrapUpRequestedAt: string | null;
  events: ActivityEvent[];
  result: ActivityResultRecord | null;
  /** The journey-edit staging draft this walk verifies; null for every other Activity. */
  sourceProposalId: string | null;
}

export interface DispatchJobIdentity {
  id: string;
  teamId: string;
  projectId: string;
  kind: DispatchJobKind;
  suiteRunId: string | null;
  activityId: string | null;
  idempotencyKey: string;
  writeScope: Record<string, unknown>;
  status: DispatchJobStatus;
  expiresAt: string;
}

export interface DispatchJobLeaseCapability {
  jobId: string;
  identityHash: string;
  workerId: string;
  leaseToken: string;
}

export interface ClaimedDispatchJob extends DispatchJobIdentity {
  leaseToken: string;
  leaseOwner: string;
  leaseExpiresAt: string;
}

interface ExecutionRepository {
  id: string;
  githubInstallationId: string;
  installationId: number;
  githubRepositoryId: number;
  ownerLogin: string;
  repositoryName: string;
  defaultBranch: string;
}

export interface SuiteExecutionInput {
  kind: "suite_run";
  job: ClaimedDispatchJob;
  suiteRunId: string;
  /** The root of the run's family: the run id agents name their data by. A retry shares its root's. */
  familyRunId: string;
  suiteId: string;
  snapshotId: string;
  productionUrl: string;
  testingContext: string | null;
  repositoryId: string | null;
  repositoryCommitSha: string | null;
  repository: ExecutionRepository | null;
  authProfileId: string | null;
  authProfileStateVersion: string | null;
  promptContractVersions: Record<string, string>;
  cases: Array<{
    id: string;
    sourceCaseId: string | null;
    position: number;
    title: string;
    steps: JourneyStep[];
    category: string;
    checkpoints: JourneyCheckpoint[];
    preconditions: string[];
    revision: number | null;
    /** A Journey, or a setup/teardown hook around the run. */
    role: SuiteCaseRole;
    /** For a per-journey hook: the sibling snapshot Case id it is appended to. */
    scopeCaseId: string | null;
  }>;
}

/**
 * A saved way into the tested product bound to this Project and ready to use,
 * carried to the agent so it can offer the ways in as a choice at a login
 * gate. Only the method and the human label travel — never any credential or
 * session bytes; the sealed material stays on the host.
 */
export interface BoundSignIn {
  method: string;
  label: string | null;
}

export interface ActivityExecutionInput {
  kind: "activity";
  job: ClaimedDispatchJob;
  activity: ActivitySummary;
  protectedInput: string | null;
  /** Whether the Activity's legs record their screen: a walk's protected input says so (control-plane store/walks.ts). */
  recordScreen: boolean;
  repositoryId: string | null;
  repositoryCommitSha: string | null;
  promptContractVersion: string;
  productionUrl: string;
  testingContext: string | null;
  repository: ExecutionRepository | null;
  /** Bound, ready sign-ins for this Project (method + label only). */
  boundSignIns: BoundSignIn[];
  suites: Array<{
    id: string;
    name: string;
    definitionRevision: number;
    cases: Array<{
      id: string;
      title: string;
      steps: JourneyStep[];
      category: string;
      checkpoints: JourneyCheckpoint[];
      whyItMatters: string | null;
      role: SuiteCaseRole;
      /** The Suite Case id of the Journey a per-journey hook is appended to. */
      scopeCaseId: string | null;
      repeat: SuiteCaseRepeat;
      enabled: boolean;
      archived: boolean;
    }>;
  }>;
}

export type DispatchExecutionInput = SuiteExecutionInput | ActivityExecutionInput;

export interface OverviewAggregate {
  testCount: number;
  runCount: number;
  passingStreak: number;
  latestRuns: SuiteRunSummary[];
  hasMoreRuns: boolean;
}

export interface RunnerRunEvent {
  id: string;
  suiteRunId: string;
  caseRunId: string | null;
  sequence: number;
  type: string;
  level: RunEventLevel;
  message: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export type CaseCodeEvidenceFile = {
  path: string;
  lineStart: number | null;
  lineEnd: number | null;
  rationale: string;
};

export type CaseCodeEvidence = {
  status: "corroborated" | "inconclusive";
  summary: string;
  commitSha: string;
  files: CaseCodeEvidenceFile[];
};

export interface CaseRunTrust {
  reproducedRuns: ReproducedRunCount;
  codeEvidence: CaseCodeEvidence | null;
}

export interface RunnerCaseRun {
  id: string;
  suiteRunId: string;
  snapshotCaseId: string;
  position: number;
  attempt: number;
  status: CaseRunStatus;
  verdict: CaseVerdict | null;
  checklist: CaseChecklistItem[];
  summary: string | null;
  failureReason: string | null;
  trust: CaseRunTrust;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunnerArtifact {
  id: string;
  caseRunId: string;
  kind: ArtifactKind;
  label: string;
  mimeType: string | null;
  sizeBytes: number | null;
  storageStatus: ArtifactStorageStatus;
  createdAt: string;
}

export interface BrowserRecording {
  id: string;
  caseRunId: string | null;
  storageStatus: BrowserRecordingStorageStatus;
  mimeType: BrowserRecordingMimeType | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hasPoster: boolean;
  playback: BrowserRecordingPlaybackMetadata;
  createdAt: string;
}
