/**
 * The one-shot state that ties an install redirect back to the user and team
 * who started it. GitHub's App installation and Slack's workspace install are
 * the same handshake — mint a token, park only its hash, let exactly one
 * redirect redeem it — so they share this module rather than each carrying a
 * copy that drifts. What differs between the two providers is where the
 * redirect goes and what comes back from it, which is the provider's own code.
 */
import { createHash, randomBytes } from "node:crypto";

const STATE_TTL_SECONDS = 10 * 60;
const MAX_STATE_TTL_SECONDS = 15 * 60;

/** 32 random bytes as base64url: what a redirect must carry before the store is touched at all. */
export const INSTALL_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type InstallStateErrorCode =
  | "invalid_state"
  | "expired_state"
  | "state_user_mismatch"
  | "state_replayed";

export class InstallStateError extends Error {
  readonly code: InstallStateErrorCode;

  constructor(code: InstallStateErrorCode, message: string) {
    super(message);
    this.name = "InstallStateError";
    this.code = code;
  }
}

export interface PendingInstallState {
  stateHash: string;
  userId: string;
  teamId: string;
  createdAt: string;
  expiresAt: string;
}

export type ConsumeInstallStateResult =
  | { status: "ok"; record: PendingInstallState }
  | { status: "missing" | "expired" | "user_mismatch" | "consumed" };

export interface InstallStateStore {
  save(record: PendingInstallState): Promise<void>;
  /** This operation must compare the user and consume the row atomically. */
  consume(input: {
    stateHash: string;
    expectedUserId: string;
    now: string;
  }): Promise<ConsumeInstallStateResult>;
}

export interface IssueInstallStateOptions {
  now?: Date | undefined;
  ttlSeconds?: number | undefined;
  randomState?: (() => Buffer) | undefined;
}

export interface IssuedInstallState {
  state: string;
  expiresAt: string;
}

/** What the store keys a pending redirect by; the token itself is never persisted. */
export function hashInstallState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

export async function issueInstallState(
  store: InstallStateStore,
  identity: { userId: string; teamId: string },
  options: IssueInstallStateOptions = {},
): Promise<IssuedInstallState> {
  if (!identity.userId || !identity.teamId) {
    throw new InstallStateError("invalid_state", "The install state identity is invalid.");
  }
  const ttlSeconds = options.ttlSeconds ?? STATE_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > MAX_STATE_TTL_SECONDS) {
    throw new Error(`Install state TTL must be between 60 and ${MAX_STATE_TTL_SECONDS} seconds.`);
  }
  const stateBytes = (options.randomState ?? (() => randomBytes(32)))();
  if (stateBytes.byteLength !== 32) {
    throw new Error("An install state must contain 32 random bytes.");
  }

  const state = stateBytes.toString("base64url");
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000).toISOString();
  await store.save({
    stateHash: hashInstallState(state),
    userId: identity.userId,
    teamId: identity.teamId,
    createdAt: now.toISOString(),
    expiresAt,
  });
  return { state, expiresAt };
}

export async function consumeInstallState(
  store: InstallStateStore,
  input: { state: string; expectedUserId: string; now?: Date },
): Promise<PendingInstallState> {
  if (!INSTALL_STATE_PATTERN.test(input.state) || !input.expectedUserId) {
    throw new InstallStateError("invalid_state", "The install state is invalid.");
  }
  const result = await store.consume({
    stateHash: hashInstallState(input.state),
    expectedUserId: input.expectedUserId,
    now: (input.now ?? new Date()).toISOString(),
  });
  if (result.status === "ok") return result.record;
  if (result.status === "expired") {
    throw new InstallStateError("expired_state", "The install state has expired.");
  }
  if (result.status === "user_mismatch") {
    throw new InstallStateError("state_user_mismatch", "The install state belongs to another user.");
  }
  if (result.status === "consumed") {
    throw new InstallStateError("state_replayed", "The install state was already used.");
  }
  throw new InstallStateError("invalid_state", "The install state is invalid.");
}
