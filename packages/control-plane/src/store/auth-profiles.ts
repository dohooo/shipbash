/**
 * Target-auth profile rows: one per (project, production origin), created
 * lazily the first time a Run snapshot needs one.
 */
import type postgres from "postgres";

import type {
	SuiteRunStatus,
	TargetAuthProfileStatus,
} from "@shipbash/contracts/database-contract-types";
import { generatedTextId } from "./normalize.ts";
import type { SelectedRow } from "./table-rows.ts";

export type RunAuthProfileRow = SelectedRow<
	"target_auth_profiles",
	"id" | "state_version" | "status",
	{
		status: TargetAuthProfileStatus;
	}
>;

/**
 * The Run's own status, for callers that hold in-process claims against it.
 * Null when the Run is gone — which counts as finished for every such caller.
 */
export async function readRunStatus(
	sql: postgres.Sql | postgres.TransactionSql,
	runId: string,
): Promise<SuiteRunStatus | null> {
	const rows = await sql<Array<{ status: SuiteRunStatus }>>`
    select status from public.suite_runs where id = ${runId}
  `;
	return rows[0]?.status ?? null;
}

export function runStatusIsTerminal(status: SuiteRunStatus | null): boolean {
	return status === null || status === "completed" || status === "canceled";
}

export async function ensureRunAuthProfileRow(
	sql: postgres.Sql | postgres.TransactionSql,
	input: {
		teamId: string;
		projectId: string;
		productionOrigin: string;
		locator: string;
	},
): Promise<RunAuthProfileRow> {
	const rows = await sql<RunAuthProfileRow[]>`
    insert into public.target_auth_profiles (
      id, project_id, team_id, production_origin, status,
      profile_locator, state_locator
    ) values (
      ${generatedTextId("auth_profile")}, ${input.projectId}, ${input.teamId}::uuid,
      ${input.productionOrigin}, 'missing', ${`${input.locator}:profile`},
      ${`${input.locator}:state`}
    )
    on conflict (project_id, production_origin) do update
    set team_id = excluded.team_id
    returning id, state_version, status
  `;
	const row = rows[0];
	if (!row) throw new Error("Target auth profile was not returned.");
	return row;
}
