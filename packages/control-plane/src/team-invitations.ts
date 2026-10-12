import { createHash, randomBytes } from "node:crypto";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface IssuedTeamInvitationToken {
  token: string;
  tokenHash: string;
  expiresAt: string;
}

export function hashTeamInvitationToken(token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error("Team invitation token is invalid.");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function issueTeamInvitationToken(
  options: { now?: Date; randomToken?: () => Buffer } = {},
): IssuedTeamInvitationToken {
  const bytes = (options.randomToken ?? (() => randomBytes(32)))();
  if (bytes.byteLength !== 32) throw new Error("Team invitation token must contain 32 random bytes.");
  const now = options.now ?? new Date();
  if (Number.isNaN(now.valueOf())) throw new Error("Team invitation issue time is invalid.");
  const token = bytes.toString("base64url");
  return {
    token,
    tokenHash: hashTeamInvitationToken(token),
    expiresAt: new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
  };
}

export function teamInvitationPath(token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error("Team invitation token is invalid.");
  return `/invitations/${encodeURIComponent(token)}`;
}
