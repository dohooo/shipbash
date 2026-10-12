/**
 * Sign in with Slack attempts (slack_sign_ins): one row from leaving for Slack
 * to confirming the identity it came back with.
 *
 * Every statement is bound to the account that started the attempt, so a
 * state, or an attempt's id, in anyone else's hands finds nothing. The
 * caller has already verified whatever Slack said; nothing here talks to it.
 */
import type postgres from "postgres";

import type { SlackSignInIdentity } from "../slack-sign-in.ts";
import { nonEmpty, sha256, timestamp } from "./normalize.ts";
import type { SlackUser } from "./slack-user-links.ts";

type Queryable = postgres.Sql | postgres.TransactionSql;

/** Leaving for Slack: the state's hash, the nonce, and where @ShipBash asked from. */
export interface SlackSignInStart {
  stateHash: string;
  nonce: string;
  slackTeamId: string;
  channelId: string;
  expiresAt: string;
}

/** An attempt whose state Slack's redirect just spent, and what its id_token must match. */
export interface SpentSlackSignIn {
  id: string;
  nonce: string;
  /** The workspace @ShipBash asked from; the one signed in to must be it. */
  slackTeamId: string;
}

/** What the confirm screen names: the verified Slack identity, and the channel to go back to. */
export interface SlackSignInView {
  slackTeamId: string;
  slackTeamName: string;
  slackUserName: string;
  channelId: string;
}

/** An account has one attempt at a time: leaving for Slack again drops the one before. */
export async function insertSlackSignIn(
  sql: Queryable,
  input: SlackSignInStart & { userId: string },
): Promise<void> {
  await sql`
    with earlier as (
      delete from public.slack_sign_ins where user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
    )
    insert into public.slack_sign_ins (user_id, state_hash, nonce, slack_team_id, channel_id, expires_at)
    values (
      ${nonEmpty(input.userId, "actor.userId")}::uuid, ${sha256(input.stateHash, "stateHash")},
      ${nonEmpty(input.nonce, "nonce")}, ${nonEmpty(input.slackTeamId, "slackTeamId")},
      ${nonEmpty(input.channelId, "channelId")}, ${timestamp(input.expiresAt, "expiresAt")}
    )
  `;
}

/** Spends the state in the one statement that finds it, so a replayed redirect finds nothing. */
export async function spendSlackSignInState(
  sql: Queryable,
  input: { userId: string; stateHash: string },
): Promise<SpentSlackSignIn | null> {
  const [row] = await sql<Array<{ id: string; nonce: string; slack_team_id: string }>>`
    update public.slack_sign_ins set state_hash = null
    where state_hash = ${sha256(input.stateHash, "stateHash")}
      and user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
      and expires_at > clock_timestamp()
    returning id, nonce, slack_team_id
  `;
  return row ? { id: row.id, nonce: row.nonce, slackTeamId: row.slack_team_id } : null;
}

/** False when the attempt is gone: another one replaced it while Slack was answering. */
export async function recordSlackSignInIdentity(
  sql: Queryable,
  input: { userId: string; id: string; identity: SlackSignInIdentity },
): Promise<boolean> {
  const { identity } = input;
  const recorded = await sql`
    update public.slack_sign_ins
    set slack_user_id = ${identity.slackUserId}, slack_user_name = ${identity.slackUserName},
      slack_team_name = ${identity.slackTeamName}
    where id = ${nonEmpty(input.id, "id")}::uuid
      and user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
      and state_hash is null and slack_user_id is null
  `;
  return recorded.count === 1;
}

export async function selectSlackSignIn(
  sql: Queryable,
  input: { userId: string; id: string },
): Promise<SlackSignInView | null> {
  const [row] = await sql<Array<{
    slack_team_id: string;
    slack_team_name: string;
    slack_user_name: string;
    channel_id: string;
  }>>`
    select slack_team_id, slack_team_name, slack_user_name, channel_id
    from public.slack_sign_ins
    where id = ${nonEmpty(input.id, "id")}::uuid
      and user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
      and slack_user_id is not null
      and expires_at > clock_timestamp()
  `;
  return row
    ? {
        slackTeamId: row.slack_team_id,
        slackTeamName: row.slack_team_name,
        slackUserName: row.slack_user_name,
        channelId: row.channel_id,
      }
    : null;
}

/** Ends a confirmed attempt, answering with the Slack user it verified; null when there is none to confirm. */
export async function deleteSlackSignIn(
  sql: Queryable,
  input: { userId: string; id: string },
): Promise<SlackUser | null> {
  const [row] = await sql<Array<{ slack_team_id: string; slack_user_id: string }>>`
    delete from public.slack_sign_ins
    where id = ${nonEmpty(input.id, "id")}::uuid
      and user_id = ${nonEmpty(input.userId, "actor.userId")}::uuid
      and slack_user_id is not null
      and expires_at > clock_timestamp()
    returning slack_team_id, slack_user_id
  `;
  return row ? { slackTeamId: row.slack_team_id, slackUserId: row.slack_user_id } : null;
}
