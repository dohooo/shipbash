export { JOB_API_HOST_VARIABLE, jobApiForwardUrl, jobApiHost, jobApiOrigin } from "./job-api-contract.mjs";

export declare const JOB_LEASE_LOST: string;

export declare const TASK_API_CONFIG_FILE: "task-api.json";
export declare const TASK_API_METHODS: readonly ["credentialsRead", "credentialsOutcome", "agentTool", "repositoryToken"];
export type TaskApiMethod = (typeof TASK_API_METHODS)[number];

/** What the runner is handed: where to ask, the bearer to ask with (none in a Sandbox), and the accounts on offer. */
export interface TaskApiConfig {
  endpoint: string;
  token: string | null;
  signIns: unknown[];
}

export declare function writeTaskApiConfig(directory: string, config: TaskApiConfig | undefined): Promise<string | null>;

/**
 * How a failed call may be sent again: `safe` methods (and the heartbeat, on
 * a shorter attempt) on any network error, 408, 429 or 5xx; `once` methods
 * only when the request never left.
 */
export type JobApiRetry = "safe" | "once" | "heartbeat";

export declare const JOB_METHOD_RETRY: Readonly<{
  claimDispatchJob: "safe";
  heartbeatDispatchJob: "heartbeat";
  isDispatchCancellationRequested: "safe";
  loadDispatchExecutionInput: "safe";
  appendRunEventsForJob: "once";
  appendActivityEventsForJob: "once";
  startCaseRunForJob: "once";
  updateCaseChecklistForJob: "once";
  updateCaseTrustForJob: "once";
  completeCaseRunForJob: "once";
  completeActivityForJob: "once";
  createProposalForJob: "once";
  recordKnowledgeEntryForJob: "once";
  saveActivityAgentSessionForJob: "once";
  markActivityWaitingForInputForJob: "once";
  markActivityRunningAfterInputForJob: "once";
  withdrawActivityQuestionForJob: "once";
  withdrawOpenActivityQuestionForJob: "once";
  markActivityInlineAuthWaitingForJob: "once";
  markActivityInlineAuthRunningForJob: "once";
  releaseDispatchJobWaitingForAuth: "once";
  markTargetAuthProfileExpiredForJob: "once";
  markTargetAuthProfileFailedForJob: "once";
  markDispatchFinalizationFailed: "once";
  completeDispatchJob: "once";
  failDispatchJob: "once";
  cancelDispatchJob: "once";
  drawWorkProgress: "once";
  trustedAccess: "safe";
  signInOpen: "safe";
  credentialsList: "safe";
  credentialsRead: "safe";
  repositoryToken: "safe";
  signInKeep: "once";
  credentialsOutcome: "once";
  uploadsPrepare: "safe";
  recordingPrepare: "safe";
  uploadsSettle: "once";
  recordingSettle: "once";
  activityOpening: "safe";
  suiteOpening: "safe";
  agentTool: "safe";
}>;

/** Every method's wire name: control-plane's registry is held to exactly these (job-api/retry.ts). */
export type JobApiMethod = keyof typeof JOB_METHOD_RETRY;

export interface JobApiClient {
  /** The method's result, typed by the caller: client and server ship in one release, so it is not re-validated. */
  call<Result = unknown>(method: JobApiMethod, args: readonly unknown[]): Promise<Result>;
}

export declare function createJobApiClient(options: { endpoint: string; token?: string }): JobApiClient;

/** A refusal in the envelope: its status, its code, and the words the client throws. */
export interface JobApiFailure {
  status: number;
  error: string;
  message: string;
}

export declare const MAX_JOB_BODY_BYTES: number;

export declare function readJobApiArguments(
  body: AsyncIterable<Uint8Array> | null,
  contentEncoding: string | null | undefined,
): Promise<{ args: unknown[] } | JobApiFailure>;

export declare function unknownJobMethod(name: string): JobApiFailure;

export declare function jobApiFailure(error: unknown): JobApiFailure;

export declare function jobApiAnswer(
  acceptEncoding: string | null | undefined,
  outcome: { result: unknown } | JobApiFailure,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer<ArrayBuffer> }>;
