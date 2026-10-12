import "server-only";

import { isRecord } from "./is-record";
import { runnerOrigin } from "./runner-proxy";

const MAX_WEBHOOK_BYTES = 1024 * 1024;

/**
 * One provider's webhook endpoint: where the Runner serves it, and the headers
 * its signature is computed over. Nothing else is forwarded — a webhook
 * authenticates by its signature, so an `authorization` or actor header
 * arriving on one would be somebody else's claim riding along.
 */
interface WebhookEndpoint {
  path: string;
  headers: readonly string[];
}

export function webhookJson(status: number, payload: Record<string, unknown>): Response {
  return Response.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * What a hosted handler answers when it fails in a way it did not expect: the
 * envelope the local service sends through `sendLocalRouteError`, so a provider
 * sees one endpoint whichever runtime is behind it, rather than the framework's
 * HTML 500 page. Surface the real failure in server logs — a silent 500 is
 * undebuggable — and never in the answer, which reaches an unauthenticated
 * caller.
 */
export function webhookInternalError(scope: string, error: unknown): Response {
  console.error(`[${scope}] unhandled error:`, error);
  return webhookJson(500, {
    ok: false,
    error: "INTERNAL_ERROR",
    message: "The request could not be completed.",
  });
}

function tooLarge(): Response {
  return webhookJson(413, {
    ok: false,
    error: "BODY_TOO_LARGE",
    message: "Webhook payload is too large.",
  });
}

/** The delivery's bytes, or the refusal when they exceed what a webhook may carry. */
export async function readWebhookBody(request: Request): Promise<ArrayBuffer | Response> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) return tooLarge();
  const body = await request.arrayBuffer();
  return body.byteLength > MAX_WEBHOOK_BYTES ? tooLarge() : body;
}

export async function proxyWebhook(request: Request, endpoint: WebhookEndpoint): Promise<Response> {
  const body = await readWebhookBody(request);
  if (body instanceof Response) return body;

  const headers = new Headers();
  for (const name of endpoint.headers) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("content-length", String(body.byteLength));

  let upstream: Response;
  try {
    upstream = await fetch(new URL(endpoint.path, runnerOrigin()), {
      method: "POST",
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
      signal: request.signal,
    });
  } catch {
    return webhookJson(503, {
      ok: false,
      error: "WEBHOOK_UNAVAILABLE",
      message: "Webhook processing is temporarily unavailable.",
    });
  }

  let payload: Record<string, unknown> = { ok: upstream.ok };
  try {
    const candidate: unknown = await upstream.json();
    if (isRecord(candidate)) {
      payload = { ...candidate };
    }
  } catch {
    // The public response remains bounded and generic when Runner output is invalid.
  }
  return webhookJson(upstream.status, payload);
}
