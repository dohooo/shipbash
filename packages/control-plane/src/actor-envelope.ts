import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { isRecord } from "./is-record.ts";

export const SHIPBASH_ACTOR_HEADER = "x-shipbash-actor";

const ACTOR_ENVELOPE_VERSION = 1;
const DEFAULT_ACTOR_TTL_SECONDS = 30;
const MAX_ACTOR_TTL_SECONDS = 120;
const MAX_CLOCK_SKEW_SECONDS = 5;
const RESERVED_ACTOR_HEADERS = new Set([
  SHIPBASH_ACTOR_HEADER,
  "x-shipbash-actor-signature",
  "x-shipbash-user-id",
  "x-shipbash-team-id",
]);

export interface ActorIdentity {
  userId: string;
}

export interface VerifiedActorIdentity extends ActorIdentity {
  issuedAt: number;
  expiresAt: number;
  requestId: string;
}

interface ActorEnvelopePayload {
  v: typeof ACTOR_ENVELOPE_VERSION;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface CreateActorEnvelopeOptions {
  now?: Date;
  ttlSeconds?: number;
  requestId?: string;
}

export interface VerifyActorEnvelopeOptions {
  now?: Date;
}

export class InvalidActorEnvelopeError extends Error {
  constructor(message = "The internal actor envelope is invalid.") {
    super(message);
    this.name = "InvalidActorEnvelopeError";
  }
}

function assertSigningSecret(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("ShipBash actor signing secret must contain at least 32 bytes.");
  }
}

function assertIdentityValue(value: string, label: string): void {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point — a secret carrying one is refused.
  if (value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new InvalidActorEnvelopeError(`${label} is invalid.`);
  }
}

function signatureFor(encodedPayload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(encodedPayload, "utf8").digest();
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new InvalidActorEnvelopeError();
  return Buffer.from(value, "base64url");
}

function isActorEnvelopePayload(value: unknown): value is ActorEnvelopePayload {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).length === 5 &&
    value.v === ACTOR_ENVELOPE_VERSION &&
    typeof value.sub === "string" &&
    Number.isSafeInteger(value.iat) &&
    Number.isSafeInteger(value.exp) &&
    typeof value.jti === "string"
  );
}

function assertEnvelopeUnexpired(payload: ActorEnvelopePayload, now: number): void {
  if (
    payload.iat > now + MAX_CLOCK_SKEW_SECONDS ||
    payload.exp <= now ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > MAX_ACTOR_TTL_SECONDS
  ) {
    throw new InvalidActorEnvelopeError("The internal actor envelope has expired.");
  }
}

export function createActorEnvelope(
  actor: ActorIdentity,
  secret: string,
  options: CreateActorEnvelopeOptions = {},
): string {
  assertSigningSecret(secret);
  assertIdentityValue(actor.userId, "Actor user ID");
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_ACTOR_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_ACTOR_TTL_SECONDS) {
    throw new Error(`Actor envelope TTL must be between 1 and ${MAX_ACTOR_TTL_SECONDS} seconds.`);
  }
  const requestId = options.requestId ?? randomUUID();
  assertIdentityValue(requestId, "Actor request ID");
  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  const payload: ActorEnvelopePayload = {
    v: ACTOR_ENVELOPE_VERSION,
    sub: actor.userId,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    jti: requestId,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${signatureFor(encodedPayload, secret).toString("base64url")}`;
}

export function verifyActorEnvelope(
  envelope: string | null | undefined,
  secret: string,
  options: VerifyActorEnvelopeOptions = {},
): VerifiedActorIdentity {
  assertSigningSecret(secret);
  if (!envelope || envelope.length > 2_048) throw new InvalidActorEnvelopeError();
  const parts = envelope.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new InvalidActorEnvelopeError();
  const [encodedPayload, encodedSignature] = parts;
  const actualSignature = decodeBase64Url(encodedSignature);
  const expectedSignature = signatureFor(encodedPayload, secret);
  if (
    actualSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new InvalidActorEnvelopeError();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Url(encodedPayload).toString("utf8"));
  } catch {
    throw new InvalidActorEnvelopeError();
  }
  if (!isActorEnvelopePayload(payload)) throw new InvalidActorEnvelopeError();
  assertIdentityValue(payload.sub, "Actor user ID");
  assertIdentityValue(payload.jti, "Actor request ID");
  const now = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  assertEnvelopeUnexpired(payload, now);
  return {
    userId: payload.sub,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    requestId: payload.jti,
  };
}

export function stripSpoofedActorHeaders(input?: HeadersInit): Headers {
  const headers = new Headers(input);
  for (const name of [...headers.keys()]) {
    const normalized = name.toLowerCase();
    if (RESERVED_ACTOR_HEADERS.has(normalized) || normalized.startsWith("x-shipbash-actor-")) {
      headers.delete(name);
    }
  }
  return headers;
}

export function withActorEnvelope(
  input: HeadersInit | undefined,
  actor: ActorIdentity,
  secret: string,
  options: CreateActorEnvelopeOptions = {},
): Headers {
  const headers = stripSpoofedActorHeaders(input);
  headers.set(SHIPBASH_ACTOR_HEADER, createActorEnvelope(actor, secret, options));
  return headers;
}
