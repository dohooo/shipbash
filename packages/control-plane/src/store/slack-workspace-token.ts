/**
 * The sealed bot token: what it is sealed against, and how a call gets it out
 * again. Both halves live here because they are the same secret — the key the
 * envelope was made with and the read that opens it must never drift apart.
 */
import type postgres from "postgres";

import type { SignInKeyring } from "../sign-in-crypto.ts";
import { nonEmpty } from "./normalize.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/**
 * The sealed bot token's authenticated data. It must survive a reconnect, so
 * it is the pair that identifies the connection rather than the row's id —
 * an upsert keeps the id, but a fresh uuid minted for the insert would not
 * be the one the envelope was sealed against.
 */
export function sealingKey(teamId: string, slackTeamId: string): string {
  return `slack:${teamId}:${slackTeamId}`;
}

/**
 * The token a call to Slack runs on, or null when this team has no such
 * workspace or Slack has already stopped honouring it. A revoked workspace is
 * refused here rather than at the call, so nothing reaches Slack on a token
 * the product already knows is dead.
 */
export async function selectSlackWorkspaceToken(
  sql: Queryable,
  keyring: SignInKeyring,
  input: { teamId: string; workspaceId: string },
): Promise<{ botToken: string; slackTeamId: string } | null> {
  const teamId = nonEmpty(input.teamId, "teamId");
  const rows = await sql<Array<{ slack_team_id: string; bot_token_ciphertext: string }>>`
    select slack_team_id, bot_token_ciphertext
    from public.slack_workspaces
    where team_id = ${teamId}::uuid
      and id = ${nonEmpty(input.workspaceId, "workspaceId")}::uuid
      and revoked_at is null
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    botToken: keyring.open(sealingKey(teamId, row.slack_team_id), row.bot_token_ciphertext),
    slackTeamId: row.slack_team_id,
  };
}

/** The token a Slack workspace's events are answered on. */
export interface SlackInstallationToken {
  botToken: string;
  botUserId: string;
}

/**
 * The token for everything Slack sends about one workspace. Slack issues one
 * bot token per app per workspace, so every team's row holds the same one and
 * the newest live connection speaks for all of them; which ShipBash team an
 * event concerns comes from who wrote it and what it is about, never from here.
 */
export async function selectSlackInstallation(
  sql: Queryable,
  keyring: SignInKeyring,
  slackTeamId: string,
): Promise<SlackInstallationToken | null> {
  const rows = await sql<Array<{ team_id: string; bot_user_id: string; bot_token_ciphertext: string }>>`
    select team_id, bot_user_id, bot_token_ciphertext
    from public.slack_workspaces
    where slack_team_id = ${nonEmpty(slackTeamId, "slackTeamId")}
      and revoked_at is null
    order by connected_at desc
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    botToken: keyring.open(sealingKey(row.team_id, slackTeamId), row.bot_token_ciphertext),
    botUserId: row.bot_user_id,
  };
}
