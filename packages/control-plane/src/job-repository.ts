/**
 * An Activity's checkout of its job's repository at the pinned commit, the
 * same in both lanes: the sandbox terminal's working copy, to run and build
 * the code, which the agents read on GitHub. The token is the job API's
 * (`repositoryToken`), minted for that one repository, read-only, per
 * request, so no task holds the GitHub App key. An Activity without a pinned
 * commit works in an empty url-only directory; one whose repository cannot be
 * checked out runs on without the checkout and says so on its timeline. A
 * suite run checks out nothing.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeRepository } from "@shipbash/contracts/runtime/repository-contract.mjs";

import { EphemeralGitHubInstallationToken } from "./github-app/token.ts";
import type { JobPort } from "./job-api/port.ts";
import { checkoutGitHubRepository } from "./repository-checkout.ts";
import type { ActivityExecutionInput } from "./types.ts";

export interface CheckedOutRepository {
  directory: string;
  cleanup(): Promise<void>;
}

/** Where a checkout is made, and the environment git runs from: the task's own, with every git and token variable stripped. */
export interface CheckoutPlace {
  root: string;
  environment: NodeJS.ProcessEnv;
}

/** The repository a task's agents read on GitHub (runner github-source.mjs): the job's own, named as the runner reads it. */
export function runtimeRepository(repository: ActivityExecutionInput["repository"]): RuntimeRepository | null {
  if (!repository) return null;
  return { owner: repository.ownerLogin, name: repository.repositoryName, defaultBranch: repository.defaultBranch };
}

async function checkout(
  port: Pick<JobPort, "repositoryToken">,
  repository: { ownerLogin: string; repositoryName: string },
  commitSha: string,
  place: CheckoutPlace,
): Promise<CheckedOutRepository> {
  const minted = await port.repositoryToken();
  return checkoutGitHubRepository({
    repository: { owner: repository.ownerLogin, name: repository.repositoryName },
    commitSha,
    token: new EphemeralGitHubInstallationToken(minted.token, minted.expiresAt),
    temporaryRoot: place.root,
    baseEnvironment: place.environment,
  });
}

/** An Activity's working directory: the repository at its commit, or an empty one with `commitSha` null. */
export interface ActivityCheckout extends CheckedOutRepository {
  commitSha: string | null;
}

async function urlOnly(place: CheckoutPlace): Promise<ActivityCheckout> {
  const directory = await mkdtemp(join(place.root, "url-only-"));
  return { directory, commitSha: null, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

/**
 * The Activity's checkout. One whose repository cannot be checked out — its
 * token refused, GitHub down — runs on without it, as a Suite does, and says
 * so on its timeline; the token's host has recorded a revocation if that was
 * the cause.
 */
export async function checkoutActivityRepository(
  port: Pick<JobPort, "repositoryToken" | "appendActivityEventsForJob">,
  input: ActivityExecutionInput,
  place: CheckoutPlace,
): Promise<ActivityCheckout> {
  await mkdir(place.root, { recursive: true, mode: 0o700 });
  const commitSha = input.repositoryCommitSha;
  if (!input.repository || !commitSha) return urlOnly(place);
  try {
    return { ...await checkout(port, input.repository, commitSha, place), commitSha };
  } catch {
    await port.appendActivityEventsForJob([{
      kind: "warning",
      label: "The linked repository could not be checked out",
      bodyMarkdown: "This leg continues without the checkout; the agent still reads the repository on GitHub.",
      safeData: { event: "repository_unavailable", outcome: "degraded" },
    }]);
    return urlOnly(place);
  }
}

