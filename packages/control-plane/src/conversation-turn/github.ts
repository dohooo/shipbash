/**
 * A conversation turn's GitHub reads: the project's bound repository through
 * GitHub's own MCP server and github_list_deployments beside it, as every
 * Sandbox agent reads it (runner github-source.mjs). The turn runs on the
 * host, where the GitHub App key is, so it mints the installation token for
 * that one repository itself, through a closure, with the job API's own mint
 * (github-app/repository-token.ts): concurrent turns share a process, and an
 * environment variable would hand one project's token to another's turn. A
 * host with no GitHub App provider offers no GitHub; one whose App is not
 * configured mints nothing, and the turn answers on without the tools, saying
 * why once (runtime.ts).
 */
import { githubAccess, type githubSource } from "@shipbash/runner/runtime/github-source.mjs";

import type { ActivityRuntimeEvent } from "../activity-runtime.ts";
import type { GitHubAppProvider } from "../github-app-provider.ts";
import { mintRepositoryToken } from "../github-app/repository-token.ts";
import type { InternalStore } from "../store/internal-store.ts";
import type { ActivityExecutionInput } from "../types.ts";

/** The turn's one warning that pi could not connect the repository's GitHub server, as a Sandbox leg words it. */
export function githubUnavailableEvent(reason: string): Pick<ActivityRuntimeEvent, "kind" | "label" | "bodyMarkdown" | "safeData"> {
  return {
    kind: "warning",
    label: "The agent cannot read the repository on GitHub in this turn",
    bodyMarkdown: null,
    safeData: { event: "github_tools_unavailable", reason },
  };
}

/**
 * The turn's GitHub data source and tools, or null when the project has no
 * ready binding or the host no GitHub App to mint with. Its tools are declared
 * directly: the turn's session resumes the thread's transcript.
 */
export function turnGitHub(
  app: Pick<GitHubAppProvider, "getApp"> | null,
  store: Pick<InternalStore, "applyGitHubConnectionChangeInternal">,
  repository: ActivityExecutionInput["repository"],
  onUnavailable: (reason: string) => void,
): ReturnType<typeof githubSource> | null {
  if (!app || !repository) return null;
  const access = githubAccess({
    mint: async () => {
      const github = await app.getApp();
      if (!github) throw new Error("GitHub is not configured on this host.");
      return mintRepositoryToken(github, store, repository);
    },
    onUnavailable,
  });
  return access.source({ owner: repository.ownerLogin, name: repository.repositoryName }, "direct");
}
