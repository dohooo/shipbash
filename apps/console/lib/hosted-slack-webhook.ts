import "server-only";

import { deliverSlackWebhook } from "@shipbash/control-plane/slack-chat/delivery";
import { after } from "next/server";

import { getProductionRuntimeResources } from "./production-resources";
import { readWebhookBody, webhookInternalError, webhookJson } from "./webhook-proxy";

/**
 * Slack's deliveries on Vercel, where no resident Runner serves them: the
 * same delivery the local service answers, run in-process against the
 * production store, with the bot's handling kept alive past the answer by
 * `after`. Slack sees one endpoint whichever runtime is behind it.
 */
export async function handleHostedSlackWebhook(request: Request): Promise<Response> {
  try {
    const delivery = getProductionRuntimeResources().slackWebhook;
    if (!delivery) {
      return webhookJson(503, {
        ok: false,
        error: "SLACK_WEBHOOK_UNAVAILABLE",
        message: "Slack webhook handling is not configured.",
      });
    }
    const body = await readWebhookBody(request);
    if (body instanceof Response) return body;
    return await deliverSlackWebhook(delivery, {
      url: request.url,
      headers: request.headers,
      rawBody: new TextDecoder().decode(body),
      waitUntil: (task) => after(() => task),
    });
  } catch (error) {
    return webhookInternalError("slack-webhook", error);
  }
}
