/**
 * The raw Postgres row shapes and dispatch marker constants the store reads.
 * Pure declarations: no SQL, no behavior.
 */
import type postgres from "postgres";
import type { TableRow } from "../generated/database/index.ts";
import type { TeamRole } from "../types.ts";
import type { Timestamp } from "./table-rows.ts";

export const TRANSIENT_RETRY_PENDING_PREFIX = "transient_retry_pending:";
export const VERCEL_WORKFLOW_DISPATCH_PENDING_PREFIX =
	"vercel_workflow_dispatch_pending:";

type Membership = TableRow<"team_memberships">;
type Profile = TableRow<"user_profiles">;

/** A profile as teammates see it. */
export type ProfileIdentityRow = Pick<Profile, "user_id" | "display_name" | "github_login" | "avatar_url" | "email"> & {
	github_user_id: Profile["github_user_id"] | string;
} & postgres.Row;

export type TeamMemberRow = ProfileIdentityRow & Pick<Membership, "team_id"> & {
	role: TeamRole;
	profile_created_at: Timestamp;
	profile_updated_at: Timestamp;
	membership_created_at: Timestamp;
} & postgres.Row;

export type CurrentUserRow = ProfileIdentityRow & { default_team_id: string | null };
export * from "./contracts.ts";
export type * from "./table-rows.ts";
export {
	ACTIVITY_ROW_COLUMNS,
	BROWSER_RECORDING_ROW_COLUMNS,
	PROJECT_ROW_COLUMNS,
	PROPOSAL_ROW_COLUMNS,
	SUITE_CASE_ROW_COLUMNS,
	SUITE_ROW_COLUMNS,
	SUITE_RUN_ROW_COLUMNS,
	TRUSTED_ACCESS_ROW_COLUMNS,
} from "./row-columns.ts";
