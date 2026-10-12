import type {
	ActivityKind,
	ScheduleCadence,
	ScheduleOccurrenceOutcome,
} from "./database-contract-types.ts";
import type {
	ActivityResultRecord,
	ActivitySummary,
	RunDispatchResult,
} from "./execution-types.ts";
import type { SlackLineFacts } from "./slack-line.ts";
import type { SteerImage } from "./steer-images.ts";

export type { ScheduleCadence } from "./database-contract-types.ts";

export interface SuiteSchedule {
	id: string;
	teamId: string;
	projectId: string;
	suiteId: string;
	cadence: ScheduleCadence;
	localTime: string | null;
	cronExpression: string | null;
	timezone: string | null;
	nextRunAt: string | null;
	lastDispatchedAt: string | null;
	lastSkippedAt: string | null;
	lastSkipReason: string | null;
	updatedAt: string;
}

export interface ScheduleOccurrence {
	id: string;
	teamId: string;
	projectId: string;
	suiteId: string;
	scheduleId: string;
	scheduledFor: string;
	outcome: ScheduleOccurrenceOutcome;
	suiteRunId: string | null;
	reason: string | null;
	createdAt: string;
}

export interface ScheduledDispatchResult {
	occurrence: ScheduleOccurrence;
	dispatch: RunDispatchResult | null;
	created: boolean;
}

/** A line said in a conversation's thread before its opening, by whom, with the images and Slack facts it carries. */
export interface ConversationContextLine {
	message: string;
	clientKey: string;
	author: string;
	images?: readonly SteerImage[];
	slack?: SlackLineFacts;
}

export interface CreateActivityInput {
	kind: ActivityKind;
	/**
	 * The run's opening instruction, recorded as its first chat message. When
	 * the host composed it (a brief), displayText is what the reader's own
	 * bubble shows; the walk reads message. images are the ones it carries, by reference.
	 * author is who said it, as a chat names them; slack, where it stands in the Slack thread it was said in;
	 * context, the lines said in that thread before it, recorded ahead of it as asides.
	 */
	initialMessage?: {
		message: string;
		clientKey: string;
		displayText?: string;
		author?: string;
		images?: readonly SteerImage[];
		slack?: SlackLineFacts;
		context?: readonly ConversationContextLine[];
	} | null;
	protectedInput?: string | null;
	/** The proposal the walk starts from: a staging draft an edit walk verifies, drafts a follow-up revises. */
	sourceProposalId?: string | null;
	triggerSource: ActivitySummary["triggerSource"];
	clientIdempotencyKey: string;
	semanticExecutionKey?: string | null;
	repositoryId?: string | null;
	repositoryCommitSha?: string | null;
	promptContractVersion: string;
	modelContract?: Record<string, unknown>;
	dispatchIdentity: {
		identityHash: string;
		expiresAt: string;
	};
}

export interface CompleteActivityInput {
	status: "completed" | "needs_attention" | "failed" | "superseded";
	resultKind: ActivityResultRecord["kind"];
	summary: string;
	attentionCode?: ActivityResultRecord["attentionCode"];
	recoveryAction?: string | null;
	proposalIds?: string[];
}
