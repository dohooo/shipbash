import {
  getPublicRunCardContract,
  getPublicVerificationContract,
  getPublicVerificationEventsContract,
} from "@shipbash/contracts/api/public-verifications";
import type { PublicRunStore } from "../store/public-run-store.ts";
import { parseQuery } from "./contracts/server.ts";
import { ApiError, type ApiRequest, type ApiResponse } from "./http.ts";

const ROOT = /^\/api\/public\/verifications\/([^/]+)$/u;
const EVENTS = /^\/api\/public\/verifications\/([^/]+)\/events$/u;
/**
 * A private run's card, by its page's address. Slugs and run ids are never
 * percent-encoded, so the segments are read as they arrive: one that was
 * encoded names nothing and gets the same 404 as an unknown run.
 */
const RUN_CARD = /^\/api\/public\/verifications\/by-run\/([^/]+)\/([^/]+)\/([^/]+)\/card$/u;
const PUBLIC_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
};

function sendPublicJson(response: ApiResponse, status: number, payload: unknown): void {
  response.writeHead(status, PUBLIC_HEADERS);
  response.end(JSON.stringify(payload));
}

function unavailable(response: ApiResponse): void {
  sendPublicJson(response, 404, {
    ok: false, error: "UNAVAILABLE", message: "This shared run is unavailable.",
  });
}

async function sendPublicRun(
  response: ApiResponse, store: Pick<PublicRunStore, "readVerification">, token: string,
): Promise<void> {
  const value = await store.readVerification(token);
  if (!value) unavailable(response);
  else sendPublicJson(response, 200, getPublicVerificationContract.response.parse({ verification: value }));
}

async function sendPublicEvents(
  response: ApiResponse, store: Pick<PublicRunStore, "readEvents">, token: string, url: URL,
): Promise<void> {
  const { run, after } = parseQuery(getPublicVerificationEventsContract.query, url);
  const value = await store.readEvents(token, run, after);
  if (!value) unavailable(response);
  else sendPublicJson(response, 200, getPublicVerificationEventsContract.response.parse(value));
}

async function sendRunCard(
  response: ApiResponse, store: Pick<PublicRunStore, "readRunCard">, [, teamSlug, projectSlug, runId]: RegExpMatchArray,
): Promise<void> {
  const address = getPublicRunCardContract.params.safeParse({ teamSlug, projectSlug, runId });
  const card = address.success ? await store.readRunCard(address.data) : null;
  if (!card) unavailable(response);
  else sendPublicJson(response, 200, getPublicRunCardContract.response.parse({ card }));
}

export async function handlePublicVerificationRequest(
  request: ApiRequest,
  response: ApiResponse,
  store: Pick<PublicRunStore, "readVerification" | "readEvents" | "readRunCard">,
): Promise<boolean> {
  if (request.method !== "GET") return false;
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const run = url.pathname.match(ROOT);
  const events = url.pathname.match(EVENTS);
  const card = url.pathname.match(RUN_CARD);
  if (!run && !events && !card) return false;
  try {
    if (run) await sendPublicRun(response, store, run[1] ?? "");
    else if (events) await sendPublicEvents(response, store, events[1] ?? "", url);
    else if (card) await sendRunCard(response, store, card);
    return true;
  } catch (error) {
    // A request the contract refuses says so; anything else is the same
    // unavailable answer a revoked link gets.
    if (error instanceof ApiError && error.statusCode === 400) {
      sendPublicJson(response, 400, { ok: false, error: error.code, message: error.message });
      return true;
    }
    console.error("[public-verification] read failed:", error instanceof Error ? error.name : "unknown");
    sendPublicJson(response, 500, {
      ok: false, error: "UNAVAILABLE", message: "This shared run is unavailable.",
    });
    return true;
  }
}
