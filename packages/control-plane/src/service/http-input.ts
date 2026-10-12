/**
 * HTTP primitives of the local service: body reading, senders, and validation.
 */
import { collectBody } from "../api/http.ts";
import { MAX_BODY_BYTES, MAX_EVENT_TEXT, REDACTED } from "./support.ts";
import type { IncomingMessage, ServerResponse } from "node:http";


export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  /** Extra fields the error envelope carries beside `error` and `message`. */
  readonly details: Record<string, unknown>;

  constructor(statusCode: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function workerCapacity(
  configured: number | undefined,
  environmentValue: string | undefined,
  fallback: number,
  label: string,
): number {
  const value = configured ?? (environmentValue === undefined ? fallback : Number(environmentValue));
  if (!Number.isInteger(value) || value < 1 || value > 32) {
    throw new Error(`${label} must be an integer between 1 and 32.`);
  }
  return value;
}

export function safeText(value: unknown, maximum = MAX_EVENT_TEXT): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, `$1${REDACTED}@`)
    .replace(
      /([?&](?:access_token|refresh_token|id_token|token|code|key|secret|password|state)=)[^&#\s]*/gi,
      `$1${REDACTED}`,
    )
    .replace(/\b(authorization|cookie|set-cookie|password|secret|token)\s*[:=]\s*[^\r\n]+/gi, `$1: ${REDACTED}`)
    .slice(0, maximum);
}

export function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

/**
 * The error envelope the local service answers with for everything outside the
 * authenticated API, which keeps its own.
 *
 * An HttpError already names its status. Anything else is a real fault and
 * stays a 500.
 */
export function sendLocalRouteError(response: ServerResponse, error: unknown): void {
  const known = error instanceof HttpError ? error : null;
  sendJson(response, known?.statusCode ?? 500, {
    ...known?.details,
    ok: false,
    error: known?.code ?? "INTERNAL_ERROR",
    message: safeText(errorMessage(error), 2_000),
  });
}

function bodyTooLarge(): HttpError {
  return new HttpError(413, "BODY_TOO_LARGE", "Request body exceeds 1 MB.");
}

export async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  return Buffer.concat(await collectBody(request, MAX_BODY_BYTES, bodyTooLarge));
}

