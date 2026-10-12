/**
 * The job-capability store facet. Every method is authorized by a Dispatch
 * Job lease (DispatchJobLeaseCapability) or is one of the lease primitives
 * themselves — no actor, no RLS session: the lease row scopes each write to
 * the job's own team/project. Consumed by the dispatch worker and the
 * sandbox task runtimes.
 */
import type postgres from "postgres";
import type { ProductKnowledgeRecord } from "../knowledge.ts";
import type {
	ActivityEvent,
	ActivityResultRecord,
	BrowserRecording,
	ClaimedDispatchJob,
	CompleteActivityInput,
	DispatchExecutionInput,
	DispatchJobLeaseCapability,
	RunnerArtifact,
	RunnerCaseRun,
	RunnerRunEvent,
	SuiteProposal,
} from "../types.ts";
import { completeActivityForJob } from "./activity-for-job.ts";
import { type ActivityAgentSession, saveActivityAgentSessionForJob } from "./activity-agent-sessions.ts";
import { registerArtifactForJob, settleArtifactsForJob } from "./artifacts-for-job.ts";
import {
	completeCaseRunForJob,
	startCaseRunForJob,
	updateCaseChecklistForJob,
	updateCaseTrustForJob,
} from "./case-runs-for-job.ts";
import type { StoreConnection } from "./connection.ts";
import { claimDispatchJob, claimReservedDispatchJob, isDispatchCancellationRequested, type LeasedDispatchJob, readLeasedDispatchJob } from "./dispatch-claims.ts";
import {
	cancelDispatchJob,
	completeDispatchJob,
	failDispatchJob,
} from "./dispatch-completion.ts";
import { loadDispatchExecutionInput } from "./dispatch-execution-input.ts";
import { type DispatchTarget, loadDispatchTarget } from "./dispatch-target.ts";
import {
	markDispatchFinalizationFailed,
	prepareDispatchJobTransientRetry,
	releaseDispatchJobWaitingForAuth,
} from "./dispatch-lifecycle.ts";
import {
	markTargetAuthProfileExpiredForJob,
	markTargetAuthProfileFailedForJob,
	readTargetAuthProfileForJob,
} from "./job-auth-profiles.ts";
import { promoteTargetAuthProfileForJob } from "./target-auth-state.ts";
import { appendActivityEventForJob, appendActivityEventsForJob, appendRunEventForJob, appendRunEventsForJob } from "./job-events.ts";
import {
	markJobActivityWaitingForInput,
	recordJobKnowledgeEntry,
	transitionJobActivityInput,
} from "./job-store-activity.ts";
import type {
	AppendActivityEventForJobInput,
	AppendRunEventForJobInput,
	ArtifactSettlementForJob,
	BrowserRecordingOwner,
	CompleteCaseRunForJobInput,
	CreateProposalForJobInput,
	KnowledgeEntryForJobInput,
	MarkBrowserRecordingAvailableForJobInput,
	MarkTargetAuthProfileExpiredForJobInput,
	MarkTargetAuthProfileFailedForJobInput,
	PromoteTargetAuthProfileForJobInput,
	RegisterArtifactForJobInput,
	TargetAuthProfileForJob,
	UpdateCaseTrustForJobInput,
} from "./job-store-inputs.ts";
import { createProposalForJob } from "./proposals-for-job.ts";
import { markBrowserRecordingAvailableForJob, markBrowserRecordingFailedForJob, registerBrowserRecordingForJob } from "./recordings-for-job.ts";
import { withdrawActivityQuestionForJob, withdrawOpenActivityQuestionForJob } from "./activity-question-withdrawal.ts";
import {
	type RemovalAnswer, type RemoveFromSuiteForJobInput, type ScheduleAnswer, type SetScheduleForJobInput, type StartVerificationForJobInput,
	type VerificationAnswer, removeFromSuiteForJob, setSuiteScheduleForJob, startVerificationForJob,
} from "./host-requests-for-job.ts";
import { type DecideAnswer, type DecideDraftsForJobInput, decideDraftsForJob } from "./draft-keep-for-job.ts";
import {
	type DecideEditsAnswer, type DecideEditsForJobInput, type VerifyEditsAnswer, type VerifyEditsForJobInput, decideEditsForJob, verifyEditsForJob,
} from "./edits-for-job.ts";
import { type DispatchHeartbeat, heartbeatDispatchJob } from "./dispatch-heartbeat.ts";
import { type StartWalkForJobInput, type TellWalkAnswer, type TellWalkInput, type WalkAnswer, answerWalkQuestionForJob, startWalkForJob } from "./walks.ts";

export class JobStore {
	private readonly sql: postgres.Sql;
	private readonly runQuota: boolean;

	constructor(connection: StoreConnection) {
		this.sql = connection.sql;
		this.runQuota = connection.runQuota;
	}

	async recordKnowledgeEntryForJob(
		capability: DispatchJobLeaseCapability,
		input: KnowledgeEntryForJobInput,
	): Promise<ProductKnowledgeRecord> {
		return recordJobKnowledgeEntry(this.sql, capability, input);
	}

	/** The leg's pi session, kept for the Activity's next leg (activity-agent-sessions.ts). */
	async saveActivityAgentSessionForJob(capability: DispatchJobLeaseCapability, session: ActivityAgentSession): Promise<void> {
		await saveActivityAgentSessionForJob(this.sql, capability, session);
	}

	/** The leg's question: recorded, waited on, and reported to a conversation that started the walk (job-store-activity.ts). */
	async markActivityWaitingForInputForJob(capability: DispatchJobLeaseCapability, question: AppendActivityEventForJobInput): Promise<void> {
		await markJobActivityWaitingForInput(this.sql, capability, question);
	}

	async markActivityRunningAfterInputForJob(
		capability: DispatchJobLeaseCapability,
	): Promise<void> {
		await transitionJobActivityInput(
			this.sql,
			capability,
			"waiting_for_input",
			"running",
		);
	}

	async claimDispatchJob(jobId: string, identityHash: string, workerId: string, leaseSeconds = 120): Promise<ClaimedDispatchJob | null> {
		return claimDispatchJob(this.sql, jobId, identityHash, workerId, leaseSeconds);
	}

	/** A Sandbox's claim of the reservation it was launched for (dispatch-claims.ts). */
	async claimReservedDispatchJob(input: { jobId: string; reservation: string; workerId: string }): Promise<ClaimedDispatchJob | null> {
		return claimReservedDispatchJob(this.sql, input);
	}

	/** The live lease a job API call is checked against (job-api/identity.ts). */
	async readLeasedDispatchJob(jobId: string): Promise<LeasedDispatchJob | null> {
		return readLeasedDispatchJob(this.sql, jobId);
	}

	/** The lease renewed, the cancel to honour, and what the leg owes its control mount: one round trip (dispatch-heartbeat.ts). */
	async heartbeatDispatchJob(capability: DispatchJobLeaseCapability, leaseSeconds = 120): Promise<DispatchHeartbeat> {
		return heartbeatDispatchJob(this.sql, capability, leaseSeconds);
	}

	async isDispatchCancellationRequested(capability: DispatchJobLeaseCapability): Promise<boolean> {
		return isDispatchCancellationRequested(this.sql, capability);
	}

	/** A question left open — by a wrap-up, or by the round ending on it — withdrawn so the leg can deliver. */
	async withdrawActivityQuestionForJob(capability: DispatchJobLeaseCapability, questionId: string): Promise<boolean> {
		return withdrawActivityQuestionForJob(this.sql, capability, questionId);
	}
	async withdrawOpenActivityQuestionForJob(capability: DispatchJobLeaseCapability): Promise<boolean> {
		return withdrawOpenActivityQuestionForJob(this.sql, capability);
	}

	async loadDispatchExecutionInput(capability: DispatchJobLeaseCapability): Promise<DispatchExecutionInput> {
		return loadDispatchExecutionInput(this.sql, capability);
	}

	/** What the job is aimed at, without the execution aggregate: its Production URL, testing context and repository (dispatch-target.ts). */
	async loadDispatchTargetForJob(capability: DispatchJobLeaseCapability): Promise<DispatchTarget> {
		return loadDispatchTarget(this.sql, capability);
	}

	async readTargetAuthProfileForJob(capability: DispatchJobLeaseCapability): Promise<TargetAuthProfileForJob | null> {
		return readTargetAuthProfileForJob(this.sql, capability);
	}

	async promoteTargetAuthProfileForJob(
		capability: DispatchJobLeaseCapability,
		input: PromoteTargetAuthProfileForJobInput,
	): Promise<boolean> {
		return promoteTargetAuthProfileForJob(this.sql, capability, input);
	}

	async markTargetAuthProfileFailedForJob(
		capability: DispatchJobLeaseCapability,
		input: MarkTargetAuthProfileFailedForJobInput,
	): Promise<boolean> {
		return markTargetAuthProfileFailedForJob(this.sql, capability, input);
	}

	async markTargetAuthProfileExpiredForJob(
		capability: DispatchJobLeaseCapability,
		input: MarkTargetAuthProfileExpiredForJobInput,
	): Promise<boolean> {
		return markTargetAuthProfileExpiredForJob(this.sql, capability, input);
	}

	async appendRunEventForJob(
		capability: DispatchJobLeaseCapability,
		input: AppendRunEventForJobInput,
	): Promise<RunnerRunEvent> {
		return appendRunEventForJob(this.sql, capability, input);
	}

	async appendActivityEventForJob(
		capability: DispatchJobLeaseCapability,
		input: AppendActivityEventForJobInput,
	): Promise<ActivityEvent> {
		return appendActivityEventForJob(this.sql, capability, input);
	}

	/** A batch of the run's events, or the Activity's, in one transaction (job-events.ts). */
	async appendRunEventsForJob(capability: DispatchJobLeaseCapability, events: readonly AppendRunEventForJobInput[]): Promise<void> {
		await appendRunEventsForJob(this.sql, capability, events);
	}
	async appendActivityEventsForJob(capability: DispatchJobLeaseCapability, events: readonly AppendActivityEventForJobInput[]): Promise<void> {
		await appendActivityEventsForJob(this.sql, capability, events);
	}

	async startCaseRunForJob(
		capability: DispatchJobLeaseCapability,
		snapshotCaseId: string,
		attempt?: number,
	): Promise<RunnerCaseRun> {
		return startCaseRunForJob(this.sql, capability, snapshotCaseId, attempt);
	}

	async updateCaseChecklistForJob(
		capability: DispatchJobLeaseCapability,
		caseRunId: string,
		checklist: RunnerCaseRun["checklist"],
	): Promise<RunnerCaseRun> {
		return updateCaseChecklistForJob(this.sql, capability, caseRunId, checklist);
	}

	async updateCaseTrustForJob(
		capability: DispatchJobLeaseCapability,
		caseRunId: string,
		input: UpdateCaseTrustForJobInput,
	): Promise<RunnerCaseRun> {
		return updateCaseTrustForJob(this.sql, capability, caseRunId, input);
	}

	async completeCaseRunForJob(
		capability: DispatchJobLeaseCapability,
		caseRunId: string,
		input: CompleteCaseRunForJobInput,
	): Promise<RunnerCaseRun> {
		return completeCaseRunForJob(this.sql, capability, caseRunId, input);
	}

	async registerArtifactForJob(
		capability: DispatchJobLeaseCapability,
		caseRunId: string,
		input: RegisterArtifactForJobInput,
	): Promise<RunnerArtifact> {
		return registerArtifactForJob(this.sql, capability, caseRunId, input);
	}

	/** A batch of Suite artifacts kept or lost, each with its timeline line, in one transaction (artifacts-for-job.ts). */
	async settleArtifactsForJob(capability: DispatchJobLeaseCapability, settlements: readonly ArtifactSettlementForJob[]): Promise<void> {
		await settleArtifactsForJob(this.sql, capability, settlements);
	}

	async registerBrowserRecordingForJob(
		capability: DispatchJobLeaseCapability,
		owner: BrowserRecordingOwner,
	): Promise<BrowserRecording> {
		return registerBrowserRecordingForJob(this.sql, capability, owner);
	}

	async markBrowserRecordingAvailableForJob(
		capability: DispatchJobLeaseCapability,
		recordingId: string,
		input: MarkBrowserRecordingAvailableForJobInput,
	): Promise<void> {
		return markBrowserRecordingAvailableForJob(this.sql, capability, recordingId, input);
	}

	async markBrowserRecordingFailedForJob(
		capability: DispatchJobLeaseCapability,
		recordingId: string,
		reason: string,
	): Promise<void> {
		return markBrowserRecordingFailedForJob(this.sql, capability, recordingId, reason);
	}

	async completeActivityForJob(
		capability: DispatchJobLeaseCapability,
		input: CompleteActivityInput,
	): Promise<ActivityResultRecord> {
		return completeActivityForJob(this.sql, capability, input);
	}

	async createProposalForJob(capability: DispatchJobLeaseCapability, input: CreateProposalForJobInput): Promise<SuiteProposal> {
		return createProposalForJob(this.sql, capability, input);
	}

	// A conversation's start_verification, set_schedule, remove_from_suite and decide_drafts, done as the Activity's creator (host-requests-for-job.ts, draft-keep-for-job.ts).
	async startVerificationForJob(capability: DispatchJobLeaseCapability, input: StartVerificationForJobInput): Promise<VerificationAnswer> {
		return startVerificationForJob(this.sql, capability, input, this.runQuota);
	}
	async setSuiteScheduleForJob(capability: DispatchJobLeaseCapability, input: SetScheduleForJobInput): Promise<ScheduleAnswer> {
		return setSuiteScheduleForJob(this.sql, capability, input);
	}
	async removeFromSuiteForJob(capability: DispatchJobLeaseCapability, input: RemoveFromSuiteForJobInput): Promise<RemovalAnswer> {
		return removeFromSuiteForJob(this.sql, capability, input);
	}
	async decideDraftsForJob(capability: DispatchJobLeaseCapability, input: DecideDraftsForJobInput): Promise<DecideAnswer> {
		return decideDraftsForJob(this.sql, capability, input, this.runQuota);
	}
	// The edits staged to the Suite, walked and decided as the Activity's creator (edits-for-job.ts).
	async verifyEditsForJob(capability: DispatchJobLeaseCapability, input: VerifyEditsForJobInput): Promise<VerifyEditsAnswer> {
		return verifyEditsForJob(this.sql, capability, input, this.runQuota);
	}
	async decideEditsForJob(capability: DispatchJobLeaseCapability, input: DecideEditsForJobInput): Promise<DecideEditsAnswer> {
		return decideEditsForJob(this.sql, capability, input);
	}

	// A conversation's walk, started as the Activity's creator, and its tell_walk: the answer to the question a walk of its thread waits on (walks.ts).
	async startWalkForJob(capability: DispatchJobLeaseCapability, input: StartWalkForJobInput): Promise<WalkAnswer> {
		return startWalkForJob(this.sql, capability, input, this.runQuota);
	}
	async answerWalkQuestionForJob(capability: DispatchJobLeaseCapability, input: TellWalkInput): Promise<TellWalkAnswer> {
		return answerWalkQuestionForJob(this.sql, capability, input);
	}

	async releaseDispatchJobWaitingForAuth(
		capability: DispatchJobLeaseCapability,
	): Promise<void> {
		return releaseDispatchJobWaitingForAuth(this.sql, capability);
	}

	async markActivityInlineAuthWaitingForJob(
		capability: DispatchJobLeaseCapability,
	): Promise<void> {
		await transitionJobActivityInput(
			this.sql,
			capability,
			"running",
			"waiting_for_auth",
			"Running Activity not found for inline auth handoff.",
		);
	}

	async markActivityInlineAuthRunningForJob(
		capability: DispatchJobLeaseCapability,
	): Promise<void> {
		await transitionJobActivityInput(
			this.sql,
			capability,
			"waiting_for_auth",
			"running",
			"Waiting Activity not found for inline auth resume.",
		);
	}

	async prepareDispatchJobTransientRetry(
		capability: DispatchJobLeaseCapability,
		reason: string,
	): Promise<void> {
		return prepareDispatchJobTransientRetry(this.sql, capability, reason);
	}

	async markDispatchFinalizationFailed(
		capability: DispatchJobLeaseCapability,
		reason: string,
	): Promise<void> {
		return markDispatchFinalizationFailed(this.sql, capability, reason);
	}

	async completeDispatchJob(
		capability: DispatchJobLeaseCapability,
		hookFailureReason?: string,
	): Promise<boolean> {
		return completeDispatchJob(this.sql, capability, hookFailureReason);
	}

	async failDispatchJob(
		capability: DispatchJobLeaseCapability,
		reason: string,
	): Promise<void> {
		return failDispatchJob(this.sql, capability, reason);
	}

	async cancelDispatchJob(
		capability: DispatchJobLeaseCapability,
		reason = "Canceled by worker.",
	): Promise<void> {
		return cancelDispatchJob(this.sql, capability, reason);
	}
}
