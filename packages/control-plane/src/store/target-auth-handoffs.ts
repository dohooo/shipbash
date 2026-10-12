/**
 * The one product sign-in handoff a Project runs at a time. A handoff's
 * Sandbox is created for it and deleted when it ends, so the Project's row
 * here is what two requests agree on: which run or Activity is waiting, and
 * once the viewer is up, the Sandbox and the command showing it. The row is
 * claimed before any Sandbox exists (a second claim finds it and stops), and
 * released when the handoff is promoted, canceled, or found dead.
 */
import type postgres from "postgres";

import type { StoreConnection } from "./connection.ts";
import { iso, nonEmpty } from "./normalize.ts";
import type { Timestamp } from "./rows.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

export interface TargetAuthHandoffTarget {
  teamId: string;
  projectId: string;
  targetKind: "run" | "activity";
  targetId: string;
}

export interface TargetAuthHandoff extends TargetAuthHandoffTarget {
  /** Null until the viewer is up: the claim is held, the Sandbox not yet created. */
  sandboxName: string | null;
  commandId: string | null;
  startedAt: string;
}

/** What the hosted sign-in handoff needs of the store. */
export interface TargetAuthHandoffAccess {
  read(projectId: string): Promise<TargetAuthHandoff | null>;
  /** Takes the Project's one handoff slot; false when another handoff holds it. */
  claim(target: TargetAuthHandoffTarget): Promise<boolean>;
  /** Names the viewer once it answers; the row must still be this target's. */
  attachViewer(target: TargetAuthHandoffTarget, viewer: { sandboxName: string; commandId: string }): Promise<void>;
  release(projectId: string): Promise<void>;
}

interface HandoffRow {
  team_id: string;
  project_id: string;
  target_kind: "run" | "activity";
  target_id: string;
  sandbox_name: string | null;
  command_id: string | null;
  started_at: Timestamp;
}

export async function readTargetAuthHandoff(sql: Queryable, projectId: string): Promise<TargetAuthHandoff | null> {
  const [row] = await sql<HandoffRow[]>`
    select team_id, project_id, target_kind, target_id, sandbox_name, command_id, started_at
    from public.target_auth_handoffs
    where project_id = ${nonEmpty(projectId, "projectId")}
  `;
  if (!row) return null;
  return {
    teamId: row.team_id,
    projectId: row.project_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    sandboxName: row.sandbox_name,
    commandId: row.command_id,
    startedAt: iso(row.started_at, "target_auth_handoffs.started_at"),
  };
}

export async function claimTargetAuthHandoff(sql: Queryable, target: TargetAuthHandoffTarget): Promise<boolean> {
  const rows = await sql`
    insert into public.target_auth_handoffs (project_id, team_id, target_kind, target_id)
    values (
      ${nonEmpty(target.projectId, "projectId")}, ${nonEmpty(target.teamId, "teamId")}::uuid,
      ${target.targetKind}, ${nonEmpty(target.targetId, "targetId")}
    )
    on conflict (project_id) do nothing
    returning project_id
  `;
  return rows.length === 1;
}

export async function attachTargetAuthHandoffViewer(
  sql: Queryable,
  target: TargetAuthHandoffTarget,
  viewer: { sandboxName: string; commandId: string },
): Promise<void> {
  const rows = await sql`
    update public.target_auth_handoffs
    set sandbox_name = ${nonEmpty(viewer.sandboxName, "sandboxName")},
        command_id = ${nonEmpty(viewer.commandId, "commandId")}
    where project_id = ${nonEmpty(target.projectId, "projectId")}
      and team_id = ${nonEmpty(target.teamId, "teamId")}::uuid
      and target_kind = ${target.targetKind}
      and target_id = ${nonEmpty(target.targetId, "targetId")}
    returning project_id
  `;
  if (rows.length !== 1) throw new Error("The authentication handoff is no longer this target's.");
}

export async function releaseTargetAuthHandoff(sql: Queryable, projectId: string): Promise<void> {
  await sql`delete from public.target_auth_handoffs where project_id = ${nonEmpty(projectId, "projectId")}`;
}

export class TargetAuthHandoffStore implements TargetAuthHandoffAccess {
  constructor(private readonly connection: StoreConnection) {}

  read(projectId: string): Promise<TargetAuthHandoff | null> {
    return readTargetAuthHandoff(this.connection.sql, projectId);
  }

  claim(target: TargetAuthHandoffTarget): Promise<boolean> {
    return claimTargetAuthHandoff(this.connection.sql, target);
  }

  attachViewer(target: TargetAuthHandoffTarget, viewer: { sandboxName: string; commandId: string }): Promise<void> {
    return attachTargetAuthHandoffViewer(this.connection.sql, target, viewer);
  }

  release(projectId: string): Promise<void> {
    return releaseTargetAuthHandoff(this.connection.sql, projectId);
  }
}
