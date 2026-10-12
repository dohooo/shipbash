// The types for github-source.mjs: a conversation's host turn reads the bound
// repository through it (control-plane conversation-turn/).
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { DataSource } from "./pi-sdk.mjs";

/** A pi custom tool that a lane's own wrappers can call with the call alone, as they call every tool they build. */
export type GitHubTool = ToolDefinition & {
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }>;
};

/** The server GitHub's tools come from, so pi names them `mcp__github__*`. */
export declare const GITHUB_SOURCE: string;

/** A call that read the bound repository: one of GitHub's server's tools, or the deployments tool beside it. */
export declare function isGitHubRead(tool: string): boolean;

/** The tools a session reading GitHub holds: github_list_deployments, and every tool GitHub's server lists. */
export declare const GITHUB_SOURCE_TOOLS: readonly string[];

/** The selection every GitHub data source sends: toolsets, read-only, never pinned names. */
export declare const GITHUB_HEADERS: Readonly<Record<string, string>>;

/** One cached installation token, minted again under five minutes from expiry, each registered for masking first. */
export declare function repositoryTokenHolder(
  mint: () => Promise<unknown>,
  options?: { registerSecret?: (value: string) => unknown; now?: () => number },
): () => Promise<string>;

/** The repository's GitHub reads for one session: the MCP server, and github_list_deployments beside it. */
export declare function githubSource(
  repository: { owner: string; name: string },
  token: () => Promise<string>,
  options: { exposure: DataSource["exposure"]; onUnavailable: (reason: string) => void },
): { dataSource: DataSource; tools: GitHubTool[] };

/** A lane's GitHub reads: one token for every session, and one warning when a session's server cannot be connected. */
export declare function githubAccess(lane: {
  mint: () => Promise<unknown>;
  registerSecret?: (value: string) => unknown;
  onUnavailable: (reason: string) => void;
}): {
  source(repository: { owner: string; name: string } | null | undefined, exposure: DataSource["exposure"]): ReturnType<typeof githubSource> | null;
};
