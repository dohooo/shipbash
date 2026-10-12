/**
 * The names and secrets one takeover session is identified by: its
 * deterministic container name, the short hash its runtime directory and label
 * carry, and the one-shot viewer password.
 */
import { createHash, randomBytes } from "node:crypto";

import { requiredString } from "@shipbash/contracts/runtime/contract-values.mjs";

export function humanAuthContainerName(sessionIdValue: string): string {
  const sessionId = requiredString(sessionIdValue, "sessionId", 512);
  const readable = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 48) || "session";
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return `shipbash-human-auth-${readable}-${digest}`;
}

export function authSessionHash(sessionIdValue: string): string {
  const sessionId = requiredString(sessionIdValue, "sessionId", 512);
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
}

export function humanAuthPassword(): string {
  return randomBytes(6).toString("base64url");
}
