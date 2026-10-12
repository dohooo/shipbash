/**
 * The short-lived, repository-scoped installation token. It never leaves this
 * object as a value: callers hand in an operation, and every ordinary
 * serialization of the holder redacts it.
 */
import { inspect } from "node:util";

import type { App } from "@octokit/app";

import { isNonNullObject } from "../is-record.ts";
import { GitHubSecurityError } from "./errors.ts";
import { assertPositiveInteger } from "./identifiers.ts";

const MIN_TOKEN_LIFETIME_MS = 30_000;
const MAX_TOKEN_LIFETIME_MS = 65 * 60_000;

export class EphemeralGitHubInstallationToken {
  readonly expiresAt: string;
  readonly #token: string;

  constructor(token: string, expiresAt: string) {
    if (!token || !Number.isFinite(Date.parse(expiresAt))) {
      throw new GitHubSecurityError("invalid_token", "GitHub returned an invalid installation token.");
    }
    this.#token = token;
    this.expiresAt = expiresAt;
  }

  async use<T>(operation: (token: string) => Promise<T>): Promise<T> {
    if (Date.parse(this.expiresAt) <= Date.now() + 5_000) {
      throw new GitHubSecurityError("invalid_token", "The GitHub installation token has expired.");
    }
    return operation(this.#token);
  }

  toString(): string {
    return "[REDACTED GitHub installation token]";
  }

  toJSON(): { type: string; expiresAt: string } {
    return { type: "github_installation_token", expiresAt: this.expiresAt };
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/**
 * The one repository's read permissions: its code and metadata for the
 * checkout, and its pull requests, issues, checks, Actions runs and
 * deployments for the agents' GitHub reads (runner github-source.mjs). None
 * writes, so a token that leaks from a task can only read that one
 * repository, for its hour.
 */
const REPOSITORY_READ_PERMISSIONS = Object.freeze({
  contents: "read",
  metadata: "read",
  pull_requests: "read",
  issues: "read",
  checks: "read",
  actions: "read",
  deployments: "read",
});

/** A read-only token for one repository: the checkout's, and the agents' GitHub tools'. */
export async function createGitHubInstallationToken(
  app: Pick<App, "octokit">,
  input: { installationId: number; repositoryId: number; now?: Date },
): Promise<EphemeralGitHubInstallationToken> {
  assertPositiveInteger(input.installationId, "GitHub installation ID");
  assertPositiveInteger(input.repositoryId, "GitHub repository ID");
  const now = input.now ?? new Date();

  let authentication: unknown;
  try {
    authentication = await app.octokit.auth({
      type: "installation",
      installationId: input.installationId,
      repositoryIds: [input.repositoryId],
      permissions: { ...REPOSITORY_READ_PERMISSIONS },
    });
  } catch {
    throw new GitHubSecurityError("invalid_token", "GitHub could not issue an installation token.");
  }
  if (!isNonNullObject(authentication)) {
    throw new GitHubSecurityError("invalid_token", "GitHub returned an invalid installation token.");
  }
  const token = authentication.token;
  const expiresAt = authentication.expiresAt;
  const lifetime = typeof expiresAt === "string" ? Date.parse(expiresAt) - now.getTime() : Number.NaN;
  if (
    authentication.tokenType !== "installation" ||
    typeof token !== "string" ||
    typeof expiresAt !== "string" ||
    !Number.isFinite(lifetime) ||
    lifetime < MIN_TOKEN_LIFETIME_MS ||
    lifetime > MAX_TOKEN_LIFETIME_MS
  ) {
    throw new GitHubSecurityError("invalid_token", "GitHub returned an invalid installation token.");
  }
  return new EphemeralGitHubInstallationToken(token, expiresAt);
}
