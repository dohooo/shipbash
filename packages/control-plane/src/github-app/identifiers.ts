/**
 * The shapes every GitHub identifier has to hold before it reaches a URL, a
 * clone command or a durable row: owner and repository names, numeric IDs and
 * commit SHAs.
 */
import { GitHubSecurityError } from "./errors.ts";

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export function isGitHubOwner(value: string): boolean {
  return OWNER_PATTERN.test(value);
}

export function assertSafeGitHubRepositoryCoordinates(
  owner: string,
  name: string,
): void {
  if (
    !OWNER_PATTERN.test(owner) ||
    !REPOSITORY_PATTERN.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new GitHubSecurityError("invalid_repository", "The GitHub repository name is invalid.");
  }
}

export function githubCloneUrl(owner: string, name: string): string {
  assertSafeGitHubRepositoryCoordinates(owner, name);
  return `https://github.com/${owner}/${name}.git`;
}

export function isGitHubCommitSha(value: unknown): value is string {
  return typeof value === "string" && COMMIT_PATTERN.test(value);
}

export function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GitHubSecurityError("invalid_repository", `${label} is invalid.`);
  }
}
