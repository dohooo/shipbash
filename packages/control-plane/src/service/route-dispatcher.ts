/**
 * The HTTP route dispatcher: one ordered walk over every handler shard.
 *
 * The service assembles the channels once; this module owns only the order
 * routes are tried in (the webhooks first, the job API and the authenticated
 * API before the health probe) plus the routes with no shard of their own:
 * the provider webhooks (their own module), the job API's mount, and the
 * health probe.
 */
import { SHIPBASH_VERSION } from "@shipbash/contracts/version";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { handlePublicVerificationRequest } from "../api/routes-public-verifications.ts";
import { handlePublicMediaRequest, type PublicMediaStorage } from "../api/public-media.ts";
import { handlePublicLiveRequest } from "../api/public-live.ts";
import { handleJobApiRequest, type JobApiDeps } from "../job-api/server.ts";

import {
  type WebhookControls,
  dispatchWebhookRoutes,
} from "./route-dispatcher-webhooks.ts";
import type { TenantStore } from "../store/tenant-store.ts";
import {
  handleApiRequest,
  isAuthenticatedApiPath,
  type ApiOptions,
} from "../api.ts";
import { HttpError, sendJson } from "./http-input.ts";

/** The wired handler channels, assembled once by the composition root. */
export interface RouteDispatcherContext extends WebhookControls {
  baseUrl: string;
  /** Null when the authenticated API is unconfigured; those paths then 503. */
  apiOptions: (() => ApiOptions) | null;
  publicMedia: PublicMediaStorage | null;
  /** Null when the service runs store-less; the public routes then 503. */
  tenantStore: TenantStore | null;
  /** What the job API serves a real Sandbox's calls from, through a tunnel; null store-less. */
  jobApi: JobApiDeps | null;
}

const JOB_API_PATH = /^\/api\/jobs\/([^/]+)\/([^/]+)$/u;

/**
 * Hands a Node request to a Web handler and streams its answer back. Closing
 * the response aborts the handler's request. `withBody` streams the request
 * body to the handler as it reads it, with every header the caller sent.
 */
async function respondWithWebResult(
  request: IncomingMessage,
  response: ServerResponse,
  baseUrl: string,
  handle: (webRequest: Request) => Promise<Response>,
  init: { headers?: Record<string, string>; withBody?: boolean } = {},
): Promise<void> {
  const abort = new AbortController();
  response.once("close", () => abort.abort());
  const headers = init.withBody ? sentHeaders(request) : init.headers;
  const body: RequestInit & { duplex?: "half" } = init.withBody ? { body: pulledBody(request), duplex: "half" } : {};
  const webRequest = new Request(new URL(request.url ?? "/", baseUrl), {
    method: request.method ?? "GET",
    ...(headers ? { headers } : {}),
    ...body,
    signal: abort.signal,
  });
  await writeWebResult(response, await handle(webRequest));
}

/**
 * The request's body as a Web stream, read only as the handler reads it.
 * (Readable.toWeb's stream is typed apart from the global one.)
 */
function pulledBody(request: IncomingMessage): ReadableStream<Uint8Array> {
  const chunks = request[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
  });
}

function sentHeaders(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(Object.entries(request.headers).flatMap(([name, value]) =>
    value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]]));
}

async function writeWebResult(response: ServerResponse, result: Response): Promise<void> {
  response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
  if (!result.body) {
    response.end();
    return;
  }
  try {
    await pipeline(Readable.from(result.body), response);
  } catch {
    // Headers are already committed. A canceled seek or broken upstream must
    // close the stream, never try to append a JSON 500 to video bytes.
    if (!response.destroyed) response.destroy();
  }
}

/** A Sandbox's call, its body streamed to the handler: the handler settles who calls before it reads the body. */
async function dispatchJobApi(
  request: IncomingMessage,
  response: ServerResponse,
  baseUrl: string,
  jobApi: JobApiDeps | null,
  match: RegExpExecArray,
): Promise<void> {
  if (!jobApi) throw new HttpError(503, "API_UNAVAILABLE", "The job API is unavailable.");
  // The path's own segments: a malformed one fails the token's audience check.
  const route = { jobId: match[1] ?? "", method: match[2] ?? "" };
  await respondWithWebResult(request, response, baseUrl, (webRequest) => handleJobApiRequest(webRequest, route, jobApi), { withBody: true });
}

async function dispatchPublicMedia(
  request: IncomingMessage,
  response: ServerResponse,
  baseUrl: string,
  context: RouteDispatcherContext,
): Promise<void> {
  const store = context.tenantStore;
  const media = context.publicMedia;
  if (!store || !media) throw new HttpError(503, "MEDIA_UNAVAILABLE", "Public media is unavailable.");
  const range = request.headers.range;
  await respondWithWebResult(
    request,
    response,
    baseUrl,
    (webRequest) => handlePublicMediaRequest(webRequest, store.publicRuns, media),
    typeof range === "string" ? { headers: { range } } : {},
  );
}

async function dispatchPublicLive(
  request: IncomingMessage, response: ServerResponse, baseUrl: string, context: RouteDispatcherContext,
): Promise<void> {
  const store = context.tenantStore;
  if (!store) throw new HttpError(503, "API_UNAVAILABLE", "Public verification is unavailable.");
  await respondWithWebResult(request, response, baseUrl, (webRequest) => handlePublicLiveRequest(webRequest, store.publicRuns));
}

/** The authenticated API; an unhandled authenticated path falls through to the rest of the walk. */
async function dispatchAuthenticatedApi(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteDispatcherContext,
): Promise<boolean> {
  if (!isAuthenticatedApiPath(pathname)) return false;
  if (!context.apiOptions) {
    throw new HttpError(503, "API_UNAVAILABLE", "The authenticated ShipBash API is unavailable.");
  }
  return handleApiRequest(request, response, context.apiOptions());
}

export function createRouteDispatcher(context: RouteDispatcherContext) {
  const { baseUrl, slackWebhook, tenantStore } = context;

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", baseUrl);
    const pathname = url.pathname;

    if (await dispatchWebhookRoutes(pathname, request, response, { slackWebhook })) {
      return;
    }

    if (/^\/api\/public\/verifications\/[^/]+\/media\/[^/]+\/[^/]+$/u.test(pathname)) {
      await dispatchPublicMedia(request, response, baseUrl, context);
      return;
    }

    if (/^\/api\/public\/verifications\/[^/]+\/live$/u.test(pathname)) {
      await dispatchPublicLive(request, response, baseUrl, context);
      return;
    }

    if (pathname.startsWith("/api/public/verifications/")) {
      if (!tenantStore) {
        throw new HttpError(503, "API_UNAVAILABLE", "Public verification is unavailable.");
      }
      if (await handlePublicVerificationRequest(request, response, tenantStore.publicRuns)) return;
    }

    const jobRoute = request.method === "POST" ? JOB_API_PATH.exec(pathname) : null;
    if (jobRoute) {
      await dispatchJobApi(request, response, baseUrl, context.jobApi, jobRoute);
      return;
    }

    if (await dispatchAuthenticatedApi(pathname, request, response, context)) return;

    if (request.method === "GET" && pathname === "/api/health") {
      sendJson(response, 200, { ok: true, product: "shipbash", version: SHIPBASH_VERSION });
      return;
    }

    throw new HttpError(404, "NOT_FOUND", "Route not found.");
  };
}
