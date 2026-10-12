/**
 * The durable registry of "which container backs this run".
 *
 * The service used to hold this only in memory, so a restart erased it: the
 * container was orphaned while the run's row stayed in a waiting state forever.
 * These rows are the single source of truth. In-memory maps may still cache
 * them, but every read path falls back to here, and the liveness reconciler
 * trusts nothing else.
 */
import type postgres from "postgres";
import type {
	RuntimeSessionPhase,
	RuntimeSessionSourceKind,
} from "@shipbash/contracts/database-contract-types";
import type { TableRow } from "../generated/database/index.ts";
import { expectRow } from "./expect-row.ts";
import { nonEmpty } from "./normalize.ts";
import type { SelectedRow } from "./table-rows.ts";

export type {
	RuntimeSessionPhase,
	RuntimeSessionSourceKind,
} from "@shipbash/contracts/database-contract-types";

type Queryable = postgres.Sql | postgres.TransactionSql;

export interface RuntimeSessionRecord {
	id: string;
	teamId: string;
	projectId: string;
	sourceKind: RuntimeSessionSourceKind;
	sourceId: string;
	containerName: string;
	controlDirectory: string | null;
	authViewerPort: number | null;
	authViewerUrl: string | null;
	phase: RuntimeSessionPhase;
	startedAt: string;
	heartbeatAt: string;
	endedAt: string | null;
	endReason: string | null;
}

export interface OpenRuntimeSessionInput {
	teamId: string;
	projectId: string;
	sourceKind: RuntimeSessionSourceKind;
	sourceId: string;
	containerName: string;
	controlDirectory?: string | null;
	authViewerPort?: number | null;
	authViewerUrl?: string | null;
	phase?: Exclude<RuntimeSessionPhase, "ended">;
}

export interface RuntimeSessionKey {
	sourceKind: RuntimeSessionSourceKind;
	sourceId: string;
}

type RuntimeSessionRow = SelectedRow<
	"runtime_sessions",
	keyof TableRow<"runtime_sessions">,
	{
		source_kind: RuntimeSessionSourceKind;
		phase: RuntimeSessionPhase;
		started_at: Date | string;
		heartbeat_at: Date | string;
		ended_at: Date | string | null;
	}
>;

const MAX_END_REASON = 500;

function optionalText(
	value: string | null | undefined,
	field: string,
): string | null {
	if (value === null || value === undefined) return null;
	const normalized = value.trim();
	if (!normalized) throw new Error(`${field} must not be blank when provided.`);
	return normalized;
}

function optionalPort(
	value: number | null | undefined,
	field: string,
): number | null {
	if (value === null || value === undefined) return null;
	if (!Number.isInteger(value) || value < 1 || value > 65_535) {
		throw new Error(`${field} must be a TCP port between 1 and 65535.`);
	}
	return value;
}

function isoTime(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : value;
}

function mapRuntimeSession(row: RuntimeSessionRow): RuntimeSessionRecord {
	return {
		id: row.id,
		teamId: row.team_id,
		projectId: row.project_id,
		sourceKind: row.source_kind,
		sourceId: row.source_id,
		containerName: row.container_name,
		controlDirectory: row.control_directory,
		authViewerPort: row.auth_viewer_port,
		authViewerUrl: row.auth_viewer_url,
		phase: row.phase,
		startedAt: isoTime(row.started_at),
		heartbeatAt: isoTime(row.heartbeat_at),
		endedAt: row.ended_at === null ? null : isoTime(row.ended_at),
		endReason: row.end_reason,
	};
}

const COLUMNS = `id, team_id, project_id, source_kind, source_id, container_name,
  control_directory, auth_viewer_port, auth_viewer_url, phase,
  started_at, heartbeat_at, ended_at, end_reason`;

/**
 * Records a started container. Re-registering the same run — a retry, or boot
 * adoption confirming a survivor — refreshes the container details in place
 * rather than opening a second row, which the partial unique index forbids.
 */
export async function openRuntimeSession(
	sql: Queryable,
	input: OpenRuntimeSessionInput,
): Promise<RuntimeSessionRecord> {
	const rows = await sql<RuntimeSessionRow[]>`
    insert into public.runtime_sessions (
      team_id, project_id, source_kind, source_id, container_name,
      control_directory, auth_viewer_port, auth_viewer_url, phase
    ) values (
      ${nonEmpty(input.teamId, "teamId")}::uuid,
      ${nonEmpty(input.projectId, "projectId")},
      ${input.sourceKind},
      ${nonEmpty(input.sourceId, "sourceId")},
      ${nonEmpty(input.containerName, "containerName")},
      ${optionalText(input.controlDirectory, "controlDirectory")},
      ${optionalPort(input.authViewerPort, "authViewerPort")},
      ${optionalText(input.authViewerUrl, "authViewerUrl")},
      ${input.phase ?? "starting"}
    )
    on conflict (source_kind, source_id) where ended_at is null do update
      set container_name = excluded.container_name,
          control_directory = excluded.control_directory,
          auth_viewer_port = excluded.auth_viewer_port,
          auth_viewer_url = excluded.auth_viewer_url,
          phase = excluded.phase,
          heartbeat_at = now()
    returning ${sql.unsafe(COLUMNS)}
  `;
	return mapRuntimeSession(expectRow(rows, "runtime_sessions", "insert"));
}

/**
 * Closes the session when the container exits. Idempotent: a dispose racing the
 * liveness reconciler must not resurrect or double-close a row.
 */
export async function closeRuntimeSession(
	sql: Queryable,
	key: RuntimeSessionKey,
	reason: string | null = null,
): Promise<boolean> {
	const rows = await sql<Array<{ id: string }>>`
    update public.runtime_sessions
    set phase = 'ended', ended_at = now(),
        end_reason = ${reason === null ? null : reason.trim().slice(0, MAX_END_REASON) || null}
    where source_kind = ${key.sourceKind} and source_id = ${nonEmpty(key.sourceId, "sourceId")}
      and ended_at is null
    returning id
  `;
	return rows.length > 0;
}

/** Everything boot adoption and the liveness sweep need to inspect. */
export async function listOpenRuntimeSessions(
	sql: Queryable,
): Promise<RuntimeSessionRecord[]> {
	const rows = await sql<RuntimeSessionRow[]>`
    select ${sql.unsafe(COLUMNS)}
    from public.runtime_sessions
    where ended_at is null
    order by started_at, id
    limit 200
  `;
	return rows.map(mapRuntimeSession);
}
