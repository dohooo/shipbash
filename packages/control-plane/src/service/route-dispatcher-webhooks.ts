/**
 * Slack's webhook. It belongs to no handler shard: it carries no actor and
 * authenticates by signature alone, so it is its own surface — and it must
 * win before the authenticated API, which would refuse it.
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

import { type SlackDeliveryTargets, deliverSlackWebhook } from "../slack-chat/delivery.ts";
import { HttpError, readRawBody } from "./http-input.ts";

export interface WebhookControls {
  slackWebhook: SlackDeliveryTargets | null;
}

function webHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const entry of value) result.append(name, entry);
    else if (value !== undefined) result.set(name, value);
  }
  return result;
}

/** The bot's handling outlives the answer; a failure in it is only ever logged. */
function inBackground(task: Promise<unknown>): void {
  void task.catch((error: unknown) => console.error("[slack-chat] delivery handling failed:", error));
}

/**
 * POST /api/webhooks/slack: whatever `deliverSlackWebhook` answers — a refusal,
 * the handshake, a revocation, or the bot's own answer — is written back as it
 * is. Answering 200 to a signed event we do not act on is the contract — Slack
 * retries anything else.
 */
async function handleSlackWebhookRoute(
  request: IncomingMessage,
  response: ServerResponse,
  slackWebhook: SlackDeliveryTargets | null,
): Promise<void> {
  if (!slackWebhook) {
    throw new HttpError(503, "SLACK_WEBHOOK_UNAVAILABLE", "Slack webhook handling is not configured.");
  }
  const answer = await deliverSlackWebhook(slackWebhook, {
    url: new URL(request.url ?? "/", "http://127.0.0.1").toString(),
    headers: webHeaders(request.headers),
    rawBody: (await readRawBody(request)).toString("utf8"),
    waitUntil: inBackground,
  });
  response.writeHead(answer.status, Object.fromEntries(answer.headers));
  response.end(Buffer.from(await answer.arrayBuffer()));
}

/** True when the request was the webhook and has been answered. */
export async function dispatchWebhookRoutes(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  controls: WebhookControls,
): Promise<boolean> {
  if (request.method !== "POST") return false;
  if (pathname === "/api/webhooks/slack") {
    await handleSlackWebhookRoute(request, response, controls.slackWebhook);
    return true;
  }
  return false;
}
