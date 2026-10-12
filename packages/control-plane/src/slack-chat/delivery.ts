/**
 * One Slack delivery: verified once, then answered.
 *
 * The connection's own deliveries are answered here: the URL handshake, which
 * must not need the database, and the two events that say the bot token is
 * finished, since Chat SDK's uninstall hook is Teams-only. Everything else
 * that is signed — mentions, messages, button clicks — goes to the bot, which
 * answers at once and hands the handling to `waitUntil`. Every outcome is a
 * Response, so both runtimes send back whatever this returns.
 */
import type { AgentServices } from "@shipbash/contracts/runtime/agent-model.mjs";

import type { SlackAppConfiguration } from "../slack-app.ts";
import {
  type SlackWebhookControl,
  type SlackWebhookDelivery,
  SlackWebhookError,
  verifyAndNormalizeSlackWebhook,
} from "../slack-webhook.ts";
import type { InternalSlackStore } from "../store/internal-lanes-slack.ts";
import { type SlackChat, type SlackChatBot, type SlackChatStore, createSlackChat } from "./bot.ts";
import type { SlackConversationPort } from "./conversation.ts";

export interface SlackDelivery {
  control: SlackWebhookControl;
  chat: SlackChat;
}

/** What answering a delivery uses: the connection's control and the bot's webhook. */
export interface SlackDeliveryTargets {
  control: SlackWebhookControl;
  chat: { bot: Pick<SlackChatBot, "webhooks"> };
}

/** The one way either runtime builds what answers Slack. */
export function createSlackDelivery(input: {
  configuration: SlackAppConfiguration;
  databaseUrl: string;
  store: Pick<InternalSlackStore, "revokeSlackWorkspaces"> & SlackChatStore;
  publicOrigin: string;
  conversations: SlackConversationPort;
  /** The Jev the bot asks whether a message is for ShipBash. */
  jev: AgentServices["jev"];
}): SlackDelivery {
  const { configuration, store } = input;
  return {
    control: {
      signingSecret: configuration.signingSecret,
      revoke: (slackTeamId) => store.revokeSlackWorkspaces(slackTeamId),
    },
    chat: createSlackChat(input),
  };
}

function json(status: number, payload: Record<string, unknown>): Response {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export async function deliverSlackWebhook(
  delivery: SlackDeliveryTargets,
  input: {
    url: string;
    headers: Headers;
    rawBody: string;
    waitUntil: (task: Promise<unknown>) => void;
  },
): Promise<Response> {
  let verdict: SlackWebhookDelivery;
  try {
    verdict = await verifyAndNormalizeSlackWebhook({
      rawBody: input.rawBody,
      headers: input.headers,
      signingSecret: delivery.control.signingSecret,
    });
  } catch (error) {
    if (!(error instanceof SlackWebhookError)) throw error;
    return json(error.code === "invalid_signature" ? 401 : 400, {
      ok: false,
      error: "INVALID_SLACK_WEBHOOK",
      message: "The Slack webhook could not be verified.",
    });
  }
  if (verdict.kind === "challenge") return json(200, { challenge: verdict.challenge });
  if (verdict.kind === "revoked") {
    return json(200, { ok: true, revoked: await delivery.control.revoke(verdict.slackTeamId) });
  }
  const request = new Request(input.url, {
    method: "POST",
    headers: input.headers,
    body: input.rawBody,
  });
  return delivery.chat.bot.webhooks.slack(request, { waitUntil: input.waitUntil });
}
