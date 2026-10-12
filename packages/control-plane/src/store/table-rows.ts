/** Store query rows projected from the generated Supabase database contract. */
import type postgres from "postgres";
import type { BrowserRecordingMimeType } from "@shipbash/contracts/database-contract-types";
import type { PublicTableName, TableRow } from "../generated/database/index.ts";
import type { KnowledgeBody, KnowledgeKind } from "../knowledge.ts";
import type {
	ACTIVITY_ROW_COLUMNS,
	BROWSER_RECORDING_ROW_COLUMNS,
	PROJECT_ROW_COLUMNS,
	PROPOSAL_ROW_COLUMNS,
	SUITE_CASE_ROW_COLUMNS,
	SUITE_ROW_COLUMNS,
	SUITE_RUN_ROW_COLUMNS,
	TRUSTED_ACCESS_ROW_COLUMNS,
} from "./row-columns.ts";
import type {
	ActivitySummary,
	BrowserRecording,
	DurableSuite,
	DurableSuiteCase,
	ProjectRepository,
	ProjectTrustedAccess,
	RunVerdict,
	SuiteCaseDefinition,
	SuiteDefinitionRevision,
	SuiteProposal,
	SuiteRunSummary,
	SuiteSchedule,
	TeamInvitation,
	TeamRole,
	TenantProject,
} from "../types.ts";

export type Timestamp = Date | string;

export type SelectedRow<
	Name extends PublicTableName,
	Keys extends keyof TableRow<Name>,
	Overrides extends object = Record<never, never>,
> = Omit<Pick<TableRow<Name>, Keys>, keyof Overrides> &
	Overrides &
	postgres.Row;

type DriverTimes<Keys extends PropertyKey> = { [Key in Keys]: Timestamp };
type OptionalDriverTimes<Keys extends PropertyKey> = {
	[Key in Keys]: Timestamp | null;
};

export type TeamRow = SelectedRow<
	"teams",
	"id" | "slug" | "name" | "created_at" | "updated_at",
	{ role: TeamRole } & DriverTimes<"created_at" | "updated_at">
>;

// Explicit keys, never keyof: a type that claims every column while the
// query's RETURNING list omits one is a lie the driver honors with
// undefined at runtime. token_hash is deliberately
// absent — the secret is matched in WHERE clauses and must never ride a row.
export type InvitationRow = SelectedRow<
	"team_invitations",
	| "id"
	| "team_id"
	| "invited_github_user_id"
	| "invited_github_login"
	| "status"
	| "created_by"
	| "accepted_by"
	| "expires_at"
	| "accepted_at"
	| "revoked_at"
	| "created_at",
	{
		invited_github_user_id: number | string;
		status: TeamInvitation["status"];
	} & DriverTimes<"expires_at" | "created_at"> &
		OptionalDriverTimes<"accepted_at" | "revoked_at">
>;

export type ProjectRow = SelectedRow<
	"projects",
	(typeof PROJECT_ROW_COLUMNS)[number],
	{
		team_id: string;
		agent_runtime: TenantProject["agentRuntime"];
		lifecycle_status: TenantProject["lifecycleStatus"];
	} & DriverTimes<"created_at" | "updated_at">
>;

type TrustedAccessKeys = (typeof TRUSTED_ACCESS_ROW_COLUMNS)[number];

export type ProjectTrustedAccessRow = SelectedRow<
	"project_trusted_access",
	TrustedAccessKeys,
	{
		mode: ProjectTrustedAccess["mode"];
		status: ProjectTrustedAccess["status"];
	} & DriverTimes<"created_at" | "updated_at"> &
		OptionalDriverTimes<"last_verified_at">
>;

export type SuiteRow = SelectedRow<
	"suites",
	(typeof SUITE_ROW_COLUMNS)[number],
	{
		lifecycle_status: DurableSuite["lifecycleStatus"];
		created_by: string;
	} & DriverTimes<"created_at" | "updated_at">
>;

export type ProposalRow = SelectedRow<
	"proposals",
	(typeof PROPOSAL_ROW_COLUMNS)[number],
	{
		kind: SuiteProposal["kind"];
		candidate_definition: SuiteCaseDefinition[];
		status: SuiteProposal["status"];
	} & DriverTimes<"created_at" | "updated_at"> &
		OptionalDriverTimes<"decided_at">
>;

export type ActivityRow = SelectedRow<
	"activities",
	(typeof ACTIVITY_ROW_COLUMNS)[number],
	{
		kind: ActivitySummary["kind"];
		trigger_source: ActivitySummary["triggerSource"];
		status: ActivitySummary["status"];
	} & DriverTimes<"created_at" | "updated_at"> &
		OptionalDriverTimes<"started_at" | "completed_at">
>;

export type SuiteRunRow = SelectedRow<
	"suite_runs",
	(typeof SUITE_RUN_ROW_COLUMNS)[number],
	{
		team_id: string;
		is_public?: boolean;
		status: SuiteRunSummary["status"];
		verdict: RunVerdict | null;
		finalization_status: SuiteRunSummary["finalizationStatus"];
		trigger_kind: SuiteRunSummary["triggerKind"];
	} & DriverTimes<"created_at"> &
		OptionalDriverTimes<"started_at" | "completed_at">
>;

export type BrowserRecordingRow = SelectedRow<
	"browser_recordings",
	(typeof BROWSER_RECORDING_ROW_COLUMNS)[number],
	{
		mime_type: BrowserRecordingMimeType | null;
		size_bytes: number | string | null;
		duration_ms: number | string | null;
		storage_status: BrowserRecording["storageStatus"];
		playback_metadata: unknown;
	} & DriverTimes<"created_at">
>;

// body is declared as the validated union, not unknown: every entry is
// checked against knowledgeEntrySchema before it is written, and a read must
// not fail a whole page over one legacy row.
export type ProductKnowledgeRow = SelectedRow<
	"product_knowledge",
	| "id"
	| "kind"
	| "title"
	| "body"
	| "page_key"
	| "source_activity_id"
	| "supersedes"
	| "created_at",
	{ kind: KnowledgeKind; body: KnowledgeBody } & DriverTimes<"created_at">
>;

export type RepositoryRow = SelectedRow<
	"project_repositories",
	keyof TableRow<"project_repositories">,
	{
		github_repository_id: number | string;
		access_status: ProjectRepository["accessStatus"];
	} & DriverTimes<"created_at" | "updated_at"> &
		OptionalDriverTimes<"last_read_at">
>;

export type SuiteCaseRow = SelectedRow<
	"suite_cases",
	(typeof SUITE_CASE_ROW_COLUMNS)[number],
	{
		steps: unknown;
		checkpoints: unknown;
		preconditions: unknown;
		role: DurableSuiteCase["role"];
		repeat: DurableSuiteCase["repeat"];
		origin: DurableSuiteCase["origin"];
	} & DriverTimes<"created_at" | "updated_at"> &
		OptionalDriverTimes<"archived_at">
>;

export type RevisionRow = SelectedRow<
	"suite_definition_revisions",
	keyof TableRow<"suite_definition_revisions">,
	{
		definition: SuiteCaseDefinition[];
		source: SuiteDefinitionRevision["source"];
	} & DriverTimes<"created_at">
>;

export type ScheduleRow = SelectedRow<
	"suite_schedules",
	| "id"
	| "team_id"
	| "project_id"
	| "suite_id"
	| "cadence"
	| "local_time"
	| "cron_expression"
	| "timezone"
	| "next_run_at"
	| "last_dispatched_at"
	| "last_skipped_at"
	| "last_skip_reason"
	| "updated_at",
	{ cadence: SuiteSchedule["cadence"] } & DriverTimes<"updated_at"> &
		OptionalDriverTimes<
			"next_run_at" | "last_dispatched_at" | "last_skipped_at"
		>
>;
