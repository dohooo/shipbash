/** The column lists each store row type is read with: one array per table, rendered by sql(array) in select and returning. */

/**
 * The one project column list: the row type's keys and every unqualified
 * RETURNING list render from this array, so a column added here reaches both
 * at once — a RETURNING list that omits a column the row type declares,
 * which made an archive succeed and then answer 500, has no seam left to
 * open.
 */
export const PROJECT_ROW_COLUMNS = [
	"id",
	"team_id",
	"slug",
	"name",
	"production_url",
	"testing_context",
	"agent_runtime",
	"lifecycle_status",
	"created_at",
	"updated_at",
] as const;

/** The project_trusted_access columns an owner may read, as PROJECT_ROW_COLUMNS. */
export const TRUSTED_ACCESS_ROW_COLUMNS = [
	"project_id",
	"team_id",
	"mode",
	"header_name",
	"status",
	"last_verified_at",
	"created_at",
	"updated_at",
] as const;

/** The suites columns a Suite maps from, as PROJECT_ROW_COLUMNS. */
export const SUITE_ROW_COLUMNS = [
	"id",
	"team_id",
	"project_id",
	"name",
	"definition_revision",
	"lifecycle_status",
	"product_thesis",
	"created_by",
	"created_at",
	"updated_at",
] as const;

/** The proposals columns a Proposal maps from, as PROJECT_ROW_COLUMNS. */
export const PROPOSAL_ROW_COLUMNS = [
	"id",
	"team_id",
	"project_id",
	"kind",
	"target_suite_id",
	"applied_suite_id",
	"base_definition_revision",
	"proposed_suite_name",
	"product_thesis",
	"candidate_definition",
	"status",
	"repository_commit_sha",
	"prompt_contract_version",
	"created_at",
	"updated_at",
	"decided_at",
] as const;

/** The activities columns an Activity summary maps from, as PROJECT_ROW_COLUMNS. */
export const ACTIVITY_ROW_COLUMNS = [
	"id",
	"team_id",
	"project_id",
	"kind",
	"trigger_source",
	"status",
	"source_activity_id",
	"generation",
	"repository_id",
	"repository_commit_sha",
	"prompt_contract_version",
	"created_at",
	"updated_at",
	"started_at",
	"completed_at",
] as const;

/** The suite_runs columns a Run summary maps from, as PROJECT_ROW_COLUMNS. */
export const SUITE_RUN_ROW_COLUMNS = [
	"id",
	"team_id",
	"project_id",
	"suite_id",
	"suite_snapshot_id",
	"source_suite_run_id",
	"status",
	"verdict",
	"finalization_status",
	"trigger_kind",
	"created_at",
	"started_at",
	"completed_at",
] as const;

/** The browser_recordings columns a recording maps from, as PROJECT_ROW_COLUMNS. */
export const BROWSER_RECORDING_ROW_COLUMNS = [
	"id",
	"case_run_id",
	"mime_type",
	"size_bytes",
	"width",
	"height",
	"duration_ms",
	"storage_status",
	"poster_object_path",
	"playback_metadata",
	"created_at",
] as const;

/** The suite_cases columns a Case maps from, as PROJECT_ROW_COLUMNS. */
export const SUITE_CASE_ROW_COLUMNS = [
	"id",
	"team_id",
	"project_id",
	"suite_id",
	"position",
	"title",
	"steps",
	"category",
	"checkpoints",
	"why_it_matters",
	"preconditions",
	"role",
	"scope_case_id",
	"repeat",
	"enabled",
	"archived_at",
	"origin",
	"revision",
	"created_at",
	"updated_at",
] as const;
