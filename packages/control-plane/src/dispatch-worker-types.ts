import type {
  runActivityInDocker,
  ActivityAgentResult,
  ActivityProposalCandidate,
  ActivityRuntimeInput,
  ActivityRuntimeOptions,
} from "./activity-runtime.ts";
import type {
  runSuiteInDocker,
  DockerRuntimeOptions,
  DockerSuiteRunResult,
} from "./docker-runtime.ts";
import type { JobStore } from "./store/job-store.ts";
import type { AppendActivityEventForJobInput, AppendRunEventForJobInput } from "./store/job-store-inputs.ts";
import type {
  ActivityExecutionInput,
  DispatchExecutionInput,
  DispatchJobLeaseCapability,
  MutableSuiteCaseInput,
  SuiteExecutionInput,
} from "./types.ts";

export interface DispatchTask {
  jobId: string;
  identityHash: string;
  expectedKind?: DispatchExecutionInput["kind"];
  /**
   * Hands a transient infrastructure failure back to be run once more
   * (local-dispatch-launcher.ts). Without it, the failure ends the job.
   */
  retryTransientFailure?: (capability: DispatchJobLeaseCapability, reason: string) => Promise<void>;
}

export type DispatchWorkerOutcome =
  | "not_claimed"
  | "completed"
  | "waiting_for_auth"
  | "failed"
  | "canceled";

/**
 * One walked Case Run and where its evidence is: the runtime writes a
 * Journey under its snapshot Case id, and each walk of a hook under the
 * walk's own run id, so the host reads each attempt's evidence, never the
 * last walk's over the first.
 */
export interface SuiteCaseRunReference {
  snapshotCaseId: string;
  caseRunId: string;
  /** The output directory of this walk, a path segment under the run's output root. */
  directory: string;
}

export interface PreparedSuiteRuntime {
  /** The snapshot's testing context and the knowledge that fits beside it, in one budget (knowledge-opening.ts). */
  testingContext: string | null;
  authState?: Record<string, unknown>;
  options?: DockerRuntimeOptions;
  retainCaseRecording?: (reference: SuiteCaseRunReference) => Promise<void>;
  failCaseRecording?: (reference: SuiteCaseRunReference, reason: string) => Promise<void>;
  finalize?: (
    result: DockerSuiteRunResult,
    caseRuns: ReadonlyArray<SuiteCaseRunReference>,
    outcome: { authStatePromoted: boolean },
  ) => void | Promise<void>;
  /** The run stopped on a sign-in wall: the sign-in it injected, if any, is dead. */
  onSignInWall?: () => Promise<void>;
  dispose?: (result?: DockerSuiteRunResult) => void | Promise<void>;
}

export interface PreparedActivityRuntime {
  input: Omit<ActivityRuntimeInput, "promptContract" | "modelContract">;
  options?: ActivityRuntimeOptions;
  dispose?: (result?: Awaited<ReturnType<ActivityRunner>>) => void | Promise<void>;
}

export interface JobProposalInput {
  sourceIndex: number;
  kind: ActivityProposalCandidate["kind"];
  targetSuiteId: string | null;
  baseDefinitionRevision: number | null;
  proposedSuiteName: string | null;
  productThesis: string | null;
  candidateCases: MutableSuiteCaseInput[];
}

/**
 * This capability-only store surface deliberately has no TenantActor method.
 * Every write must be authorized by the claimed Job's identity hash and lease.
 */
export interface DispatchWorkerStore {
  claimDispatchJob: JobStore["claimDispatchJob"];
  heartbeatDispatchJob: JobStore["heartbeatDispatchJob"];
  isDispatchCancellationRequested: JobStore["isDispatchCancellationRequested"];
  withdrawActivityQuestionForJob: JobStore["withdrawActivityQuestionForJob"];
  withdrawOpenActivityQuestionForJob: JobStore["withdrawOpenActivityQuestionForJob"];
  loadDispatchExecutionInput: JobStore["loadDispatchExecutionInput"];
  /**
   * Resolves once the event is written or, in a Sandbox, queued to be written
   * behind (job-api/remote.ts): no caller reads the record back.
   */
  appendRunEventForJob(capability: DispatchJobLeaseCapability, input: AppendRunEventForJobInput): Promise<unknown>;
  appendActivityEventForJob(capability: DispatchJobLeaseCapability, input: AppendActivityEventForJobInput): Promise<unknown>;
  startCaseRunForJob: JobStore["startCaseRunForJob"];
  updateCaseChecklistForJob: JobStore["updateCaseChecklistForJob"];
  updateCaseTrustForJob: JobStore["updateCaseTrustForJob"];
  completeCaseRunForJob: JobStore["completeCaseRunForJob"];
  completeActivityForJob: JobStore["completeActivityForJob"];
  markDispatchFinalizationFailed: JobStore["markDispatchFinalizationFailed"];
  releaseDispatchJobWaitingForAuth: JobStore["releaseDispatchJobWaitingForAuth"];
  markActivityInlineAuthWaitingForJob: JobStore["markActivityInlineAuthWaitingForJob"];
  markActivityWaitingForInputForJob: JobStore["markActivityWaitingForInputForJob"];
  markActivityRunningAfterInputForJob: JobStore["markActivityRunningAfterInputForJob"];
  recordKnowledgeEntryForJob: JobStore["recordKnowledgeEntryForJob"];
  saveActivityAgentSessionForJob: JobStore["saveActivityAgentSessionForJob"];
  markActivityInlineAuthRunningForJob: JobStore["markActivityInlineAuthRunningForJob"];
  completeDispatchJob: JobStore["completeDispatchJob"];
  failDispatchJob: JobStore["failDispatchJob"];
  cancelDispatchJob: JobStore["cancelDispatchJob"];
  createProposalForJob(
    capability: DispatchJobLeaseCapability,
    input: JobProposalInput,
  ): Promise<{ id: string }>;
}

export type SuiteRunner = typeof runSuiteInDocker;
export type ActivityRunner = typeof runActivityInDocker;

export interface DispatchWorkerOptions {
  store: DispatchWorkerStore;
  workerId: string;
  prepareActivity: (
    input: ActivityExecutionInput,
    capability: DispatchJobLeaseCapability,
    signal: AbortSignal,
  ) => Promise<PreparedActivityRuntime>;
  prepareSuite: (
    input: SuiteExecutionInput,
    capability: DispatchJobLeaseCapability,
    signal: AbortSignal,
  ) => Promise<PreparedSuiteRuntime>;
  /**
   * Recovers Case results an interrupted prior execution already produced,
   * instead of re-running the Suite. Returns true when every Case was
   * recovered; the worker then completes the Job without preparing a runtime.
   */
  recoverSuite?: (
    input: SuiteExecutionInput,
    capability: DispatchJobLeaseCapability,
  ) => Promise<boolean>;
  runSuite?: SuiteRunner;
  runActivity?: ActivityRunner;
  /**
   * The Activity has started waiting on its owner — it asked a question, it
   * needs a sign-in, or its leg ended — so whoever answers for it next can:
   * the bell that dispatches the conversation a walk reported to, the thread
   * a conversation's turn just ended in. Awaited while the worker still holds
   * the store; never throws.
   */
  onOwnerTurn?: (activityId: string) => Promise<void>;
  /** Who shows the work's progress as it goes: a Slack thread's to-do list (slack-chat/thread-lists.ts). */
  workProgress?: WorkProgress;
  leaseSeconds?: number;
  heartbeatIntervalMs?: number;
}

/** A job's work as whoever shows its progress names it: a verification run, or an Activity. */
export type WorkRef = { suiteRunId: string } | { activityId: string };

/** A work's one key, as its kind and id. */
export function workKey(work: WorkRef): string {
  return "suiteRunId" in work ? `run:${work.suiteRunId}` : `activity:${work.activityId}`;
}

/**
 * How a job's work tells whoever shows its progress how it goes. Told when
 * the worker takes the job up, as a run's Journey starts, reports a
 * checkpoint or ends, as an Activity turns to its owner and goes on again
 * once they answered or signed in, and once more when the worker is done
 * with the job. No call throws, and `moved` returns at once.
 */
export interface WorkProgress {
  /** The work moved on: shown within a few seconds. */
  moved(work: WorkRef): void;
  /** Whether the work is at work changed — the worker took its job up, it turned to its owner, or went on again: shown now. */
  changed(work: WorkRef): Promise<void>;
  /** The job stopped moving — it ended, parked, or was canceled with no worker to see it. */
  settle(work: WorkRef): Promise<void>;
}

export type RuntimeDisposition =
  | { kind: "completed"; finalizationFailure?: string; hookFailureReason?: string }
  | { kind: "waiting_for_auth" }
  | { kind: "failed"; reason: string; finalizationFailure?: string }
  | { kind: "canceled"; reason: string; finalizationFailure?: string }
  | {
      kind: "activity_completed";
      activityId: string;
      teamId: string;
      projectId: string;
      status: "completed" | "needs_attention";
      summary: string;
      attentionCode: ActivityAgentResult["attentionCode"];
      recoveryAction: string | null;
      proposalIds: string[];
    };
