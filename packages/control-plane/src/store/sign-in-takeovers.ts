/**
 * The one sign-in browser a Project drives by hand at a time, on the hosted
 * console. Its Sandbox is created for it and deleted when it ends, so the
 * Project's row here is what two requests agree on: the control lease the
 * canvas presents and, once the browser is up, the Sandbox, the command
 * running it and the stream it shows. The row is claimed before any Sandbox
 * exists (a second claim finds it and joins), and released when the sign-in
 * is saved, let go, or found dead.
 */
import type postgres from "postgres";

import type { StoreConnection } from "./connection.ts";
import { iso, nonEmpty } from "./normalize.ts";
import type { Timestamp } from "./rows.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

export interface SignInTakeoverClaim {
  teamId: string;
  projectId: string;
  /** The lease the canvas presents to drive the browser; minted with the claim, stable for its life. */
  controlToken: string;
  /** The page the browser opens on: a provider's sign-in page, or the product. */
  startUrl: string | null;
}

export interface SignInTakeoverBrowser {
  sandboxName: string;
  commandId: string;
  streamUrl: string;
}

export interface SignInTakeover extends SignInTakeoverClaim {
  /** Null until the browser is up: the claim is held, the Sandbox not yet created. */
  sandboxName: string | null;
  commandId: string | null;
  streamUrl: string | null;
  startedAt: string;
}

/** What the hosted sign-in takeover needs of the store. */
export interface SignInTakeoverAccess {
  read(projectId: string): Promise<SignInTakeover | null>;
  /** Takes the Project's one slot; false when a takeover already holds it. */
  claim(claim: SignInTakeoverClaim): Promise<boolean>;
  /** Names the browser once it answers; the row must still be held. */
  attachBrowser(projectId: string, browser: SignInTakeoverBrowser): Promise<void>;
  release(projectId: string): Promise<void>;
}

interface TakeoverRow {
  team_id: string;
  project_id: string;
  control_token: string;
  start_url: string | null;
  sandbox_name: string | null;
  command_id: string | null;
  stream_url: string | null;
  started_at: Timestamp;
}

export async function readSignInTakeover(sql: Queryable, projectId: string): Promise<SignInTakeover | null> {
  const [row] = await sql<TakeoverRow[]>`
    select team_id, project_id, control_token, start_url, sandbox_name, command_id, stream_url, started_at
    from public.sign_in_takeovers
    where project_id = ${nonEmpty(projectId, "projectId")}
  `;
  if (!row) return null;
  return {
    teamId: row.team_id,
    projectId: row.project_id,
    controlToken: row.control_token,
    startUrl: row.start_url,
    sandboxName: row.sandbox_name,
    commandId: row.command_id,
    streamUrl: row.stream_url,
    startedAt: iso(row.started_at, "sign_in_takeovers.started_at"),
  };
}

export async function claimSignInTakeover(sql: Queryable, claim: SignInTakeoverClaim): Promise<boolean> {
  const rows = await sql`
    insert into public.sign_in_takeovers (project_id, team_id, control_token, start_url)
    values (
      ${nonEmpty(claim.projectId, "projectId")}, ${nonEmpty(claim.teamId, "teamId")}::uuid,
      ${nonEmpty(claim.controlToken, "controlToken")}, ${claim.startUrl}
    )
    on conflict (project_id) do nothing
    returning project_id
  `;
  return rows.length === 1;
}

export async function attachSignInTakeoverBrowser(
  sql: Queryable,
  projectId: string,
  browser: SignInTakeoverBrowser,
): Promise<void> {
  const rows = await sql`
    update public.sign_in_takeovers
    set sandbox_name = ${nonEmpty(browser.sandboxName, "sandboxName")},
        command_id = ${nonEmpty(browser.commandId, "commandId")},
        stream_url = ${nonEmpty(browser.streamUrl, "streamUrl")}
    where project_id = ${nonEmpty(projectId, "projectId")}
    returning project_id
  `;
  if (rows.length !== 1) throw new Error("The sign-in takeover is no longer held.");
}

export async function releaseSignInTakeover(sql: Queryable, projectId: string): Promise<void> {
  await sql`delete from public.sign_in_takeovers where project_id = ${nonEmpty(projectId, "projectId")}`;
}

export class SignInTakeoverStore implements SignInTakeoverAccess {
  constructor(private readonly connection: StoreConnection) {}

  read(projectId: string): Promise<SignInTakeover | null> {
    return readSignInTakeover(this.connection.sql, projectId);
  }

  claim(claim: SignInTakeoverClaim): Promise<boolean> {
    return claimSignInTakeover(this.connection.sql, claim);
  }

  attachBrowser(projectId: string, browser: SignInTakeoverBrowser): Promise<void> {
    return attachSignInTakeoverBrowser(this.connection.sql, projectId, browser);
  }

  release(projectId: string): Promise<void> {
    return releaseSignInTakeover(this.connection.sql, projectId);
  }
}
