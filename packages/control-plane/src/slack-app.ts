/**
 * The Slack app itself: the three operator-supplied credentials, the URL a
 * workspace admin authorizes at, and the two calls an install makes against
 * Slack's Web API. Every request goes through `@chat-adapter/slack`'s
 * stateless helpers — the bot that answers people in Slack, with its client
 * and its state, is `slack-chat/`.
 *
 * The scopes are fixed and listed once. `chat:write.public` is deliberately
 * absent: a file upload fails with `not_in_channel` unless the bot is a member
 * of the channel, so the bot joins public channels itself with `channels:join`
 * rather than posting into ones it is not in. The bot reads mentions and the
 * threads it follows in channels only (no `im:*`), the authors' names
 * (`users:read`, never their email), and shows Slack's agent status
 * (`assistant:write`).
 */
import { callSlackApi } from "@chat-adapter/slack/api";

import { isRecord } from "./is-record.ts";

const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";

export const SLACK_BOT_SCOPES = [
  "chat:write",
  "channels:join",
  "files:write",
  "files:read",
  "channels:read",
  "groups:read",
  "team:read",
  "app_mentions:read",
  "channels:history",
  "groups:history",
  "users:read",
  "assistant:write",
] as const;

export const SLACK_ID_PATTERN = /^[A-Z][A-Z0-9]{1,31}$/u;

export interface SlackAppConfiguration {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

/** What one completed install produced, already checked into the shapes the store accepts. */
export interface SlackInstallation {
  slackTeamId: string;
  slackTeamName: string;
  iconUrl: string | null;
  botUserId: string;
  botToken: string;
  scopes: string[];
}

/** Slack refused the exchange, or answered with something the store cannot hold. */
export class SlackInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackInstallError";
  }
}

/**
 * The credentials, or null when this deployment has none. A partially
 * configured app is an operator mistake worth reporting here rather than at
 * the first redirect, so it throws instead of reading as "not configured".
 */
export function slackAppConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv,
): SlackAppConfiguration | null {
  const clientId = environment.SLACK_CLIENT_ID?.trim();
  const clientSecret = environment.SLACK_CLIENT_SECRET?.trim();
  const signingSecret = environment.SLACK_SIGNING_SECRET?.trim();
  if (!clientId && !clientSecret && !signingSecret) return null;
  if (!clientId || !clientSecret || !signingSecret) {
    throw new Error(
      "SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET must be configured together.",
    );
  }
  return { clientId, clientSecret, signingSecret };
}

export function slackAuthorizeUrl(input: {
  configuration: SlackAppConfiguration;
  state: string;
  redirectUri: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", input.configuration.clientId);
  url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  url.searchParams.set("state", input.state);
  url.searchParams.set("redirect_uri", input.redirectUri);
  return url.toString();
}

function requireString(value: unknown, field: string, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maxLength) {
    throw new SlackInstallError(`Slack returned no usable ${field}.`);
  }
  return text;
}

function requireSlackId(value: unknown, field: string): string {
  const id = requireString(value, field, 32);
  if (!SLACK_ID_PATTERN.test(id)) throw new SlackInstallError(`Slack returned an invalid ${field}.`);
  return id;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** The largest square Slack offers for a workspace, or null when it only has its generated default. */
function workspaceIconUrl(team: Record<string, unknown>): string | null {
  const icon = record(team.icon);
  if (icon.image_default === true) return null;
  for (const size of ["image_230", "image_132", "image_88", "image_68"]) {
    const candidate = icon[size];
    if (typeof candidate === "string" && candidate.startsWith("https://") && candidate.length <= 2048) {
      return candidate;
    }
  }
  return null;
}

/**
 * Redeems the code the authorize redirect came back with, then asks the
 * workspace what it is called. `oauth.v2.access` authenticates by the client
 * credentials in its body, so the bearer `callSlackApi` always sends is empty
 * and ignored; every later call uses the bot token this returned.
 */
export async function completeSlackInstall(input: {
  configuration: SlackAppConfiguration;
  code: string;
  redirectUri: string;
}): Promise<SlackInstallation> {
  const exchanged = await callSlackApi("oauth.v2.access", {
    client_id: input.configuration.clientId,
    client_secret: input.configuration.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
  }, { token: "" });
  if (!exchanged.ok) {
    throw new SlackInstallError(`Slack refused the install (${exchanged.error ?? "unknown_error"}).`);
  }
  const botToken = requireString(exchanged.access_token, "bot token", 512);
  const slackTeamId = requireSlackId(record(exchanged.team).id, "workspace id");
  const scopes = requireString(exchanged.scope, "scope grant", 2048).split(",").filter(Boolean);

  const info = await callSlackApi("team.info", { team: slackTeamId }, { token: botToken });
  if (!info.ok) {
    throw new SlackInstallError(`Slack would not name the workspace (${info.error ?? "unknown_error"}).`);
  }
  const team = record(info.team);
  return {
    slackTeamId,
    slackTeamName: requireString(team.name, "workspace name", 200),
    iconUrl: workspaceIconUrl(team),
    botUserId: requireSlackId(exchanged.bot_user_id, "bot user id"),
    botToken,
    scopes,
  };
}

/**
 * Tells Slack the token is finished with. Best-effort by design: the row is
 * already gone by the time this runs, and a workspace that has removed the
 * app answers `invalid_auth` for a token that is correctly forgotten.
 */
export async function revokeSlackToken(botToken: string): Promise<void> {
  try {
    await callSlackApi("auth.revoke", {}, { token: botToken });
  } catch {
    // Slack being unreachable must not keep a disconnected workspace listed.
  }
}
