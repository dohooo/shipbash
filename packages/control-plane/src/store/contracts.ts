/**
 * The store's public dispatch/schedule contracts: the shapes callers receive,
 * as opposed to the raw row shapes the SQL reads.
 */
import type {
	DispatchJobKind,
	DispatchJobStatus,
	ReproducedRunCount,
	SuiteCaseRepeat,
	SuiteCaseRole,
} from "@shipbash/contracts/database-contract-types";
import type { TableRow } from "../generated/database/index.ts";
import type {
	JourneyCheckpoint,
	JourneyStep,
} from "@shipbash/contracts/journey-contracts";
import type {
	ActivityEvent,
	CaseCodeEvidence,
	MutableSuiteCaseInput,
	RunnerCaseRun,
	ScheduledDispatchResult,
	ScheduleOccurrence,
	SuiteDefinitionRevision,
} from "../types.ts";
import type { OwnerConfirmation } from "@shipbash/contracts/runtime/case-role-contract.mjs";
import type { SelectedRow, Timestamp } from "./table-rows.ts";

export interface DueSuiteScheduleDispatch {
	scheduleId: string;
	scheduledFor: string;
	result: ScheduledDispatchResult;
}

export type OccurrenceRow = SelectedRow<
	"schedule_occurrences",
	| "id"
	| "team_id"
	| "project_id"
	| "suite_id"
	| "schedule_id"
	| "scheduled_for"
	| "outcome"
	| "suite_run_id"
	| "reason"
	| "created_at",
	{
		scheduled_for: Timestamp;
		outcome: ScheduleOccurrence["outcome"];
		created_at: Timestamp;
	}
>;

export type ActivityEventRow = SelectedRow<
	"activity_events",
	keyof TableRow<"activity_events">,
	{
		sequence: number | string;
		kind: ActivityEvent["kind"];
		safe_data: Record<string, unknown>;
		created_at: Timestamp;
	}
>;

/**
 * The dispatch_jobs columns a lease reads: the row type's keys and every list
 * that selects or returns one render from this array (as PROJECT_ROW_COLUMNS).
 */
export const DISPATCH_JOB_ROW_COLUMNS = [
	"id",
	"team_id",
	"project_id",
	"kind",
	"suite_run_id",
	"activity_id",
	"idempotency_key",
	"write_scope",
	"status",
	"expires_at",
	"lease_token",
	"lease_owner",
	"lease_expires_at",
] as const;

export type DispatchJobRow = SelectedRow<
	"dispatch_jobs",
	(typeof DISPATCH_JOB_ROW_COLUMNS)[number],
	{
		kind: DispatchJobKind;
		write_scope: Record<string, unknown>;
		status: DispatchJobStatus;
		expires_at: Timestamp;
		lease_expires_at: Timestamp | null;
	}
>;

/** The case_runs columns a Runner write returns, as DISPATCH_JOB_ROW_COLUMNS. */
export const CASE_RUN_ROW_COLUMNS = [
	"id",
	"suite_run_id",
	"snapshot_case_id",
	"position",
	"attempt",
	"status",
	"verdict",
	"checklist",
	"summary",
	"failure_reason",
	"reproduced_runs",
	"code_evidence",
	"created_at",
	"started_at",
	"completed_at",
] as const;

export type RunnerCaseRunRow = SelectedRow<
	"case_runs",
	(typeof CASE_RUN_ROW_COLUMNS)[number],
	{
		status: RunnerCaseRun["status"];
		verdict: RunnerCaseRun["verdict"];
		checklist: RunnerCaseRun["checklist"];
		reproduced_runs: ReproducedRunCount;
		code_evidence: CaseCodeEvidence | null;
		created_at: Timestamp;
		started_at: Timestamp | null;
		completed_at: Timestamp | null;
	}
>;

export interface NormalizedDispatchScope {
	teamId: string;
	projectId: string;
	idempotencyKey: string;
	identityHash: string;
	expiresAt: string;
	promptContractVersions: Record<string, string>;
	modelContract: Record<string, unknown>;
	/** Whether the dispatch is held to the team's monthly Run quota (run-quota.ts). */
	runQuota: boolean;
}

/** A Case as the store writes it: every field present, a scope already a Case id. */
export type NormalizedSuiteCaseInput = Required<
	Omit<MutableSuiteCaseInput, "scopeCandidateIndex" | "ownerConfirmation">
> & {
	id: string;
	steps: JourneyStep[];
	checkpoints: JourneyCheckpoint[];
	whyItMatters: string | null;
	preconditions: string[];
	role: SuiteCaseRole;
	scopeCaseId: string | null;
	repeat: SuiteCaseRepeat;
	/** Carried into a Proposal's candidate jsonb for the review; the save path ignores it. */
	ownerConfirmation?: OwnerConfirmation;
	enabled: boolean;
	archived: boolean;
};

export interface SaveSuiteDefinitionArguments {
	teamId: string;
	projectId: string;
	suiteId: string;
	expectedRevision: number;
	name: string;
	cases: NormalizedSuiteCaseInput[];
	source: SuiteDefinitionRevision["source"];
	sourceRef: string | null;
}
