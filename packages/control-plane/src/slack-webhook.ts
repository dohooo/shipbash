/**
 * What Slack tells us about the connection itself. Two events matter —
 * `app_uninstalled` and `tokens_revoked`, both of which say the same thing:
 * the bot token for that workspace is finished. Plus the URL-verification
 * handshake Slack runs when the endpoint is first saved. Everything else Slack
 * delivers is the bot's (`slack-chat/delivery.ts`).
 *
 * Signature verification is `@chat-adapter/slack`'s, over the exact bytes that
 * arrived. Everything else is a narrowing of the JSON it hands back: nothing
 * here touches a store, so the signature check and the decision it guards can
 * be read — and tested — in one place.
 */
import { verifySlackSignature } from "@chat-adapter/slack/webhook";
import type { SlackHeaders } from "@chat-adapter/slack/webhook";

import { isRecord } from "./is-record.ts";

const SLACK_TEAM_ID_PATTERN = /^[A-Z][A-Z0-9]{1,31}$/u;

/**
 * Whether this event means the bot token is finished.
 *
 * `app_uninstalled` always does. `tokens_revoked` does not: it reports which
 * tokens went, as `tokens: { oauth: [...], bot: [...] }`, and a user revoking
 * their own oauth token leaves the bot delivering exactly as before. Treating
 * that as a revocation would stop alerts nobody asked to stop — and the card
 * would say Slack had removed us when it had not.
 */
function endsDelivery(event: Record<string, unknown>): boolean {
  if (event.type === "app_uninstalled") return true;
  if (event.type !== "tokens_revoked") return false;
  const tokens = isRecord(event.tokens) ? event.tokens : {};
  return Array.isArray(tokens.bot) && tokens.bot.length > 0;
}

export type SlackWebhookErrorCode = "invalid_signature" | "invalid_payload";

export class SlackWebhookError extends Error {
  readonly code: SlackWebhookErrorCode;

  constructor(code: SlackWebhookErrorCode, message: string) {
    super(message);
    this.name = "SlackWebhookError";
    this.code = code;
  }
}

export type SlackWebhookDelivery =
  /** Slack proving it reached us; the challenge goes straight back. */
  | { kind: "challenge"; challenge: string }
  /** Every workspace row for this Slack team stops delivering. */
  | { kind: "revoked"; slackTeamId: string }
  /** Signed, and not about the connection: every other event, and every interactivity form. */
  | { kind: "ignored" };

function challengeOf(payload: Record<string, unknown>): string | null {
  const challenge = payload.challenge;
  return typeof challenge === "string" && challenge.length > 0 && challenge.length <= 1024
    ? challenge
    : null;
}

/**
 * Verifies the delivery and says what it means. A body that is not a JSON
 * object — an interactivity form — says nothing about the connection. A
 * revoking event without a usable workspace id is a refusal rather than a
 * silent ignore: it would otherwise read as "Slack is fine" on the one message
 * that says it is not.
 */
export async function verifyAndNormalizeSlackWebhook(input: {
  rawBody: string;
  headers: SlackHeaders;
  signingSecret: string;
  now?: () => number;
}): Promise<SlackWebhookDelivery> {
  try {
    await verifySlackSignature(input.rawBody, input.headers, {
      signingSecret: input.signingSecret,
      ...(input.now ? { now: input.now } : {}),
    });
  } catch {
    throw new SlackWebhookError("invalid_signature", "The Slack webhook signature is invalid.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    return { kind: "ignored" };
  }
  if (!isRecord(parsed)) return { kind: "ignored" };

  if (parsed.type === "url_verification") {
    const challenge = challengeOf(parsed);
    if (!challenge) {
      throw new SlackWebhookError("invalid_payload", "The Slack URL verification carried no challenge.");
    }
    return { kind: "challenge", challenge };
  }

  const event = isRecord(parsed.event) ? parsed.event : {};
  if (!endsDelivery(event)) return { kind: "ignored" };
  const slackTeamId = typeof parsed.team_id === "string" ? parsed.team_id : "";
  if (!SLACK_TEAM_ID_PATTERN.test(slackTeamId)) {
    throw new SlackWebhookError("invalid_payload", "The Slack webhook named no workspace.");
  }
  return { kind: "revoked", slackTeamId };
}

/** The signing secret and the one write a Slack delivery can cause. */
export interface SlackWebhookControl {
  signingSecret: string;
  revoke(slackTeamId: string): Promise<number>;
}
