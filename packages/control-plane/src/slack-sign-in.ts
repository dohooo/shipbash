/**
 * Sign in with Slack: Slack's OpenID Connect flow, which proves which Slack
 * user is at the keyboard (docs.slack.dev/authentication/sign-in-with-slack).
 *
 * The browser leaves for Slack's authorize URL with a state and a nonce, and
 * comes back with a code that `openid.connect.token` redeems for an id_token.
 * The token is verified as OpenID Connect prescribes: signed with one of
 * Slack's published keys, issued by Slack, addressed to this app, unexpired,
 * and carrying the nonce this attempt sent. The Slack user and their
 * workspace come from its claims and nowhere else. The user token Slack
 * returns beside it is never kept.
 *
 * Its scopes are user scopes of their own: Slack refuses them in the same
 * authorize request as the bot's (slack-app.ts), so this is a flow of its own.
 */
import { callSlackApi } from "@chat-adapter/slack/api";
import { type JWTPayload, type JWTVerifyGetKey, createRemoteJWKSet, errors, jwtVerify } from "jose";
import { z } from "zod";

import { SLACK_ID_PATTERN, type SlackAppConfiguration } from "./slack-app.ts";

const AUTHORIZE_URL = "https://slack.com/openid/connect/authorize";
const ISSUER = "https://slack.com";

/** `openid` for the user and workspace ids, `profile` for the names the confirm screen shows. */
const SLACK_SIGN_IN_SCOPES = ["openid", "profile"] as const;

/** Slack's signing keys, fetched when first needed and kept by jose. */
export const SLACK_SIGN_IN_KEYS: JWTVerifyGetKey = createRemoteJWKSet(new URL("https://slack.com/openid/connect/keys"));

/** The Slack user a verified id_token names. */
export interface SlackSignInIdentity {
  slackTeamId: string;
  slackTeamName: string;
  slackUserId: string;
  slackUserName: string;
}

/**
 * Why an attempt ends without an identity: its state is spent, someone
 * else's or gone; Slack refused it or answered with a token that does not
 * verify; or it signed in to a workspace other than the one @ShipBash asked from.
 */
type SlackSignInFailure = "expired" | "refused" | "workspace";

export class SlackSignInError extends Error {
  readonly reason: SlackSignInFailure;

  constructor(reason: SlackSignInFailure, message: string) {
    super(message);
    this.name = "SlackSignInError";
    this.reason = reason;
  }
}

const slackId = z.string().regex(SLACK_ID_PATTERN);
const slackName = z.string().min(1).max(200);

const claimsSchema = z.object({
  nonce: z.string(),
  "https://slack.com/team_id": slackId,
  "https://slack.com/team_name": slackName,
  "https://slack.com/user_id": slackId,
  name: slackName,
});

export function slackSignInUrl(input: {
  configuration: SlackAppConfiguration;
  state: string;
  nonce: string;
  slackTeamId: string;
  redirectUri: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SLACK_SIGN_IN_SCOPES.join(" "));
  url.searchParams.set("client_id", input.configuration.clientId);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  // Slack opens on the workspace @ShipBash asked from, and signs straight in
  // when this person has signed in to it before.
  url.searchParams.set("team", input.slackTeamId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  return url.toString();
}

async function verifiedPayload(idToken: string, clientId: string, keys: JWTVerifyGetKey): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: ISSUER,
      audience: clientId,
      algorithms: ["RS256"],
      requiredClaims: ["exp"],
    });
    return payload;
  } catch (error) {
    if (!(error instanceof errors.JOSEError)) throw error;
    throw new SlackSignInError("refused", `Slack's id_token did not verify (${error.code}).`);
  }
}

/**
 * Redeems the code Slack's redirect came back with and answers with the
 * Slack user its id_token names. Like `oauth.v2.access`, the token call
 * authenticates by the client credentials in its body, so the bearer
 * `callSlackApi` always sends is empty and ignored.
 */
export async function completeSlackSignIn(input: {
  configuration: SlackAppConfiguration;
  code: string;
  redirectUri: string;
  nonce: string;
  keys: JWTVerifyGetKey;
}): Promise<SlackSignInIdentity> {
  const exchanged = await callSlackApi("openid.connect.token", {
    client_id: input.configuration.clientId,
    client_secret: input.configuration.clientSecret,
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
  }, { token: "" });
  if (!exchanged.ok || typeof exchanged.id_token !== "string") {
    throw new SlackSignInError("refused", `Slack refused the sign-in (${exchanged.error ?? "no id_token"}).`);
  }
  const payload = await verifiedPayload(exchanged.id_token, input.configuration.clientId, input.keys);
  const claims = claimsSchema.safeParse(payload);
  if (!claims.success || claims.data.nonce !== input.nonce) {
    throw new SlackSignInError("refused", "Slack's id_token does not belong to this sign-in.");
  }
  return {
    slackTeamId: claims.data["https://slack.com/team_id"],
    slackTeamName: claims.data["https://slack.com/team_name"],
    slackUserId: claims.data["https://slack.com/user_id"],
    slackUserName: claims.data.name,
  };
}
