/**
 * What ShipBash asks GitHub about a connection, read live and never cached:
 * whether an installation still stands, whether a requested one landed, what
 * it may read, and a repository's default branch head. Every answer is
 * checked for the shape a durable row or a pane will rely on; anything else
 * reads as unavailable.
 */
import type { App } from "@octokit/app";
import { composePaginateRest } from "@octokit/plugin-paginate-rest";

import { isRecord } from "../is-record.ts";
import { GitHubSecurityError } from "./errors.ts";
import {
  assertPositiveInteger,
  assertSafeGitHubRepositoryCoordinates,
  isGitHubCommitSha,
  isGitHubOwner,
} from "./identifiers.ts";

type AppClient = Pick<App, "octokit" | "getInstallationOctokit" | "eachRepository">;

const MAX_LISTED_REPOSITORIES = 1_000;
/** How long one GitHub call may take before it reads as GitHub not answering. */
const GITHUB_CALL_TIMEOUT_MS = 10_000;

/** One GitHub call, given up on after the timeout: a hung GitHub must not hold a pane or a tick. */
export async function withinTimeout<T>(call: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("GitHub did not answer in time.")), GITHUB_CALL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The request option that aborts a GitHub call once the timeout has passed. */
export function timeLimited() {
  return { request: { signal: AbortSignal.timeout(GITHUB_CALL_TIMEOUT_MS) } };
}

export interface GitHubRepositoryCoordinates {
  id: number;
  owner: string;
  name: string;
  defaultBranch: string;
}

/** An installation as GitHub answers it now. `unknown` is GitHub not answering, never a verdict. */
export type InstallationProbe =
  | { kind: "healthy"; selection: "all" | "selected"; settingsUrl: string | null }
  | { kind: "suspended"; at: string }
  | { kind: "gone" }
  | { kind: "unknown" };

export interface InstallationRequest {
  accountId: number;
  accountLogin: string;
  accountType: "user" | "organization";
  requesterId: number;
  createdAt: string;
}

/** The HTTP status an octokit failure carries, or null for one that never reached GitHub. */
export function githubStatus(error: unknown): number | null {
  return isRecord(error) && typeof error.status === "number" ? error.status : null;
}

function settingsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function probeInstallation(app: AppClient, installationId: number): Promise<InstallationProbe> {
  assertPositiveInteger(installationId, "GitHub installation ID");
  let data: unknown;
  try {
    data = (await app.octokit.request("GET /app/installations/{installation_id}", {
      installation_id: installationId,
      ...timeLimited(),
    })).data;
  } catch (error) {
    return githubStatus(error) === 404 ? { kind: "gone" } : { kind: "unknown" };
  }
  if (!isRecord(data) || data.id !== installationId) return { kind: "unknown" };
  if (typeof data.suspended_at === "string" && Number.isFinite(Date.parse(data.suspended_at))) {
    return { kind: "suspended", at: new Date(data.suspended_at).toISOString() };
  }
  const selection = data.repository_selection;
  if (selection !== "all" && selection !== "selected") return { kind: "unknown" };
  return { kind: "healthy", selection, settingsUrl: settingsUrl(data.html_url) };
}

/** The installation an account has, once an owner approved it, and when it was made; null while there is none. */
export async function accountInstallation(
  app: AppClient,
  account: { login: string; type: "user" | "organization"; id: number },
): Promise<{ id: number; createdAt: string } | null> {
  if (!isGitHubOwner(account.login)) return null;
  try {
    const response = account.type === "organization"
      ? await app.octokit.request("GET /orgs/{org}/installation", { org: account.login, ...timeLimited() })
      : await app.octokit.request("GET /users/{username}/installation", { username: account.login, ...timeLimited() });
    const data: unknown = response.data;
    if (!isRecord(data) || !isRecord(data.account) || data.account.id !== account.id) return null;
    if (typeof data.id !== "number" || !Number.isSafeInteger(data.id) || data.id < 1) return null;
    if (typeof data.created_at !== "string" || !Number.isFinite(Date.parse(data.created_at))) return null;
    return { id: data.id, createdAt: new Date(data.created_at).toISOString() };
  } catch (error) {
    if (githubStatus(error) === 404) return null;
    throw error;
  }
}

function installationRequest(value: unknown): InstallationRequest | null {
  if (!isRecord(value) || !isRecord(value.account) || !isRecord(value.requester)) return null;
  const { account, requester } = value;
  if (
    typeof account.id !== "number" || !Number.isSafeInteger(account.id) || account.id < 1 ||
    typeof account.login !== "string" || !isGitHubOwner(account.login) ||
    typeof requester.id !== "number" || typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at))
  ) return null;
  return {
    accountId: account.id,
    accountLogin: account.login,
    accountType: account.type === "User" ? "user" : "organization",
    requesterId: requester.id,
    createdAt: new Date(value.created_at).toISOString(),
  };
}

/**
 * The installation requests waiting on an owner, every page of them. GitHub's
 * redirect after a request names no account, so this is the only place the
 * account is learned. The App's own client is the bare core, so the paginate
 * plugin is composed onto it, as @octokit/app does for its own listings.
 */
export async function installationRequests(app: AppClient): Promise<InstallationRequest[]> {
  // The pages' requests take no options of their own, so the whole walk is timed.
  const entries: unknown[] = await withinTimeout(
    composePaginateRest(app.octokit, "GET /app/installation-requests", { per_page: 100 }),
  );
  return entries.flatMap((entry) => installationRequest(entry) ?? []);
}

/** How many repositories the installation may read; null when GitHub could not say. */
export async function readableRepositoryCount(app: AppClient, installationId: number): Promise<number | null> {
  try {
    const octokit = await withinTimeout(app.getInstallationOctokit(installationId));
    const response = await octokit.request("GET /installation/repositories", { per_page: 1, ...timeLimited() });
    const count: unknown = response.data.total_count;
    return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

function repositoryCoordinates(value: unknown): GitHubRepositoryCoordinates | null {
  if (!isRecord(value) || !isRecord(value.owner)) return null;
  const { id, name, default_branch: defaultBranch } = value;
  const owner = value.owner.login;
  if (
    typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 ||
    typeof owner !== "string" || typeof name !== "string" ||
    typeof defaultBranch !== "string" || !defaultBranch || defaultBranch.length > 255 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point — they must never reach a header, a URL or argv.
    /[\u0000-\u001f\u007f]/u.test(defaultBranch)
  ) return null;
  try {
    assertSafeGitHubRepositoryCoordinates(owner, name);
  } catch {
    return null;
  }
  return { id, owner, name, defaultBranch };
}

/** The repositories the installation may read, up to the pane's limit. */
export async function listReadableRepositories(
  app: AppClient,
  installationId: number,
): Promise<{ repositories: GitHubRepositoryCoordinates[]; truncated: boolean }> {
  const repositories: GitHubRepositoryCoordinates[] = [];
  for await (const item of app.eachRepository.iterator({ installationId })) {
    if (repositories.length === MAX_LISTED_REPOSITORIES) return { repositories, truncated: true };
    const coordinates = repositoryCoordinates(item.repository);
    if (coordinates) repositories.push(coordinates);
  }
  return { repositories, truncated: false };
}

/** Why a read did not land: the repository left the installation, or the installation itself did. */
export class GitHubReadError extends Error {
  constructor(readonly reason: "repository_unavailable" | "installation_unavailable") {
    super(reason === "repository_unavailable"
      ? "The repository is not visible to this GitHub connection."
      : "The GitHub connection is unavailable.");
    this.name = "GitHubReadError";
  }
}

async function installationOctokit(app: AppClient, installationId: number) {
  try {
    return await withinTimeout(app.getInstallationOctokit(installationId));
  } catch {
    throw new GitHubReadError("installation_unavailable");
  }
}

/**
 * One read: the repository by its id — so a rename is followed, not lost —
 * and the commit its default branch points at now.
 */
export async function readRepository(
  app: AppClient,
  installationId: number,
  repositoryId: number,
): Promise<{ repository: GitHubRepositoryCoordinates; commitSha: string }> {
  assertPositiveInteger(installationId, "GitHub installation ID");
  assertPositiveInteger(repositoryId, "GitHub repository ID");
  const octokit = await installationOctokit(app, installationId);
  let repository: GitHubRepositoryCoordinates | null;
  try {
    const response = await octokit.request("GET /repositories/{repository_id}", { repository_id: repositoryId, ...timeLimited() });
    repository = repositoryCoordinates(response.data);
  } catch (error) {
    // Only a 404 says the repository left the installation. A 403 is as
    // likely a secondary rate limit as a refusal, so it reads as GitHub not
    // answering and leaves the binding as it was.
    if (githubStatus(error) === 404) throw new GitHubReadError("repository_unavailable");
    throw new GitHubSecurityError("repository_unavailable", "GitHub could not be read.");
  }
  if (!repository || repository.id !== repositoryId) throw new GitHubReadError("repository_unavailable");
  const head = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
    owner: repository.owner,
    repo: repository.name,
    ref: repository.defaultBranch,
    ...timeLimited(),
  });
  const commitSha = String(head.data.sha).toLowerCase();
  if (!isGitHubCommitSha(commitSha)) throw new GitHubSecurityError("repository_unavailable", "GitHub returned an invalid commit.");
  return { repository, commitSha };
}
