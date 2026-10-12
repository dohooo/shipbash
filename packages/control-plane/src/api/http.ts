/**
 * HTTP primitives of the API: body reading and validation, response
 * senders, path parsing, the actor envelope check, and the error type every
 * route speaks. No route logic and no store access belongs here.
 */
import {
  InvalidActorEnvelopeError,
  SHIPBASH_ACTOR_HEADER,
  verifyActorEnvelope,
} from "../actor-envelope.ts";
import type { TenantActor } from "../types.ts";
import { isRecord } from "../is-record.ts";


export interface ApiRequest extends AsyncIterable<Uint8Array | string> {
  readonly url?: string | undefined;
  readonly method?: string | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface ApiResponse {
  readonly writableEnded: boolean;
  writeHead(
    statusCode: number,
    headers?: Record<string, string | number | string[] | undefined>,
  ): this;
  write(chunk: string | Uint8Array): boolean;
  end(chunk?: string | Uint8Array): this;
  once(event: "close", listener: () => void): this;
}


const MAX_BODY_BYTES = 256 * 1_024;

/** The body's chunks, refused with `tooLarge()` the moment they pass `maximumBytes`. */
export async function collectBody(
  request: AsyncIterable<Uint8Array | string>,
  maximumBytes: number,
  tooLarge: () => Error,
): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maximumBytes) throw tooLarge();
    chunks.push(buffer);
  }
  return chunks;
}

export async function readJsonObject(
  request: ApiRequest,
  maxBodyBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const chunks = await collectBody(
    request,
    maxBodyBytes,
    () => new ApiError(413, "BODY_TOO_LARGE", "Request body is too large."),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new ApiError(400, "INVALID_BODY", "Request body must be an object.");
  }
  return parsed;
}

export function projectNameFromProductionUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, "INVALID_BODY", "productionUrl must be a valid HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiError(400, "INVALID_BODY", "productionUrl must use HTTP or HTTPS.");
  }
  return url.hostname.replace(/^www\./u, "").slice(0, 200);
}

/** Every answer that must never be cached, by the browser or anything between. */
export const NO_STORE_CACHE_CONTROL = "private, no-cache, no-store, must-revalidate, max-age=0";

/** Sends the browser on to `location`, uncached. */
export function sendSeeOther(response: ApiResponse, location: string): void {
  response.writeHead(303, { location, "cache-control": NO_STORE_CACHE_CONTROL });
  response.end();
}

/** An empty 204 outside any contract, uncached and never sniffed. */
export function sendNoContent(response: ApiResponse): void {
  response.writeHead(204, {
    "cache-control": NO_STORE_CACHE_CONTROL,
    "x-content-type-options": "nosniff",
  });
  response.end();
}

export function headerValue(request: ApiRequest, name: string): string | null {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export function sendJson(response: ApiResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": NO_STORE_CACHE_CONTROL,
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

export function sendArtifact(
  response: ApiResponse,
  artifact: { body: Buffer; contentType: string; label: string } | { location: string },
  download = false,
): void {
  if ("location" in artifact) {
    let location: URL;
    try {
      location = new URL(artifact.location);
    } catch {
      throw new ApiError(502, "ARTIFACT_STORAGE_INVALID_URL", "Artifact Storage returned an invalid URL.");
    }
    if (location.protocol !== "http:" && location.protocol !== "https:") {
      throw new ApiError(502, "ARTIFACT_STORAGE_INVALID_URL", "Artifact Storage returned an invalid URL.");
    }
    response.writeHead(307, {
      location: location.href,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    response.end();
    return;
  }
  const fallbackName = artifact.label.replaceAll(/[^A-Za-z0-9._-]/gu, "_") || "artifact";
  response.writeHead(200, {
    "content-type": artifact.contentType,
    "content-length": artifact.body.byteLength,
    "content-disposition": `${download ? "attachment" : "inline"}; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(artifact.label)}`,
    "cache-control": NO_STORE_CACHE_CONTROL,
    "content-security-policy": "default-src 'none'; sandbox",
    "x-content-type-options": "nosniff",
  });
  response.end(artifact.body);
}

export function onePathSegment(value: string, label: string): string {
  const decoded = decodeURIComponent(value).trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point — they must never reach a header, a URL or argv.
  if (!decoded || decoded.length > 200 || /[\u0000-\u001f\u007f/\\]/u.test(decoded)) {
    throw new ApiError(400, "INVALID_PATH", `${label} is invalid.`);
  }
  return decoded;
}

/**
 * The session endpoint is the front door where an address becomes a scope, so
 * its team parameter speaks the address vocabulary: a slug or an id. Every
 * other endpoint receives ids the client resolved from this response — this is
 * deliberately the only place the API accepts a slug. An address that names no
 * team opens the account's default one, else the first of its teams.
 */
export function selectedTeamId(
  url: URL,
  teams: readonly { id: string; slug: string }[],
  defaultTeamId: string | null,
): string {
  const requested = url.searchParams.get("team")?.trim();
  if (requested) {
    const match = teams.find((team) => team.id === requested || team.slug === requested);
    if (match) return match.id;
    throw new ApiError(404, "TEAM_NOT_FOUND", "Team was not found.");
  }
  const team = teams.find((entry) => entry.id === defaultTeamId) ?? teams[0];
  if (!team) throw new ApiError(409, "TEAM_REQUIRED", "No Team is available for this account.");
  return team.id;
}

/** The gateway a route needs, or the 503 saying this deployment has none. */
export function requireConfigured<T>(gateway: T | undefined, code: string, message: string): T {
  if (!gateway) throw new ApiError(503, code, message);
  return gateway;
}

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function actorForRequest(request: ApiRequest, secret: string): TenantActor {
  try {
    const verified = verifyActorEnvelope(headerValue(request, SHIPBASH_ACTOR_HEADER), secret);
    return { userId: verified.userId };
  } catch (error) {
    if (error instanceof InvalidActorEnvelopeError) {
      throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
    }
    throw error;
  }
}
