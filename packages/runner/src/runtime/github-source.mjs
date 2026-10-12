/**
 * The bound repository on GitHub as every agent reads it: GitHub's own hosted
 * MCP server as a data source of the session (pi-data-sources.mjs), its tools
 * `mcp__github__*`; and github_list_deployments (github-deployments.mjs),
 * which the server lacks.
 *
 * Both read with one short-lived installation token for that one repository,
 * read-only, minted on the host where the GitHub App key is: in a Sandbox
 * through the job API's repositoryToken, in a conversation's host turn by the
 * host itself. pi asks for the token on every request, so the holder hands
 * out the one it has, minted on first use and again once under five minutes
 * are left, each registered for masking before anything holds it.
 */
import { DEPLOYMENTS_TOOL_NAME, deploymentsTool } from "./github-deployments.mjs";
import { mcpServerOf } from "./pi-data-sources.mjs";

/** The server GitHub's tools come from: the data source's name, so pi names them `mcp__github__*`. */
export const GITHUB_SOURCE = "github";

const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * The tools a session reading GitHub holds: the deployments tool, and every
 * tool GitHub's server lists, declared directly or loaded by pi's
 * tool_search.
 */
export const GITHUB_SOURCE_TOOLS = Object.freeze([DEPLOYMENTS_TOOL_NAME, "mcp__github__*"]);

/** A call that read the bound repository: one of GitHub's server's tools, or the deployments tool beside it. */
export function isGitHubRead(tool) {
  return tool === DEPLOYMENTS_TOOL_NAME || mcpServerOf(tool) === GITHUB_SOURCE;
}

/**
 * The server's tools by toolset, read-only, never by pinned names: GitHub
 * refuses the whole server at initialize over a pinned name it renamed, while
 * a toolset drops a withdrawn tool and keeps the rest. The run reads the one
 * repository its brief names, and its token reads no other, so
 * search_repositories could only add other people's; an excluded name GitHub
 * no longer knows is ignored.
 */
export const GITHUB_HEADERS = Object.freeze({
  "X-MCP-Toolsets": "repos,git,issues,pull_requests,actions",
  "X-MCP-Readonly": "true",
  "X-MCP-Exclude-Tools": "search_repositories",
});

/** @param {unknown} value @returns {value is { token: string, expiresAt: string }} */
function isMintedToken(value) {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "token") === "string" && Number.isFinite(Date.parse(Reflect.get(value, "expiresAt")));
}

/**
 * The token every session of a process reads: minted on first use and again
 * once under five minutes are left, each registered for masking before it is
 * handed out. Concurrent reads share one mint; a failed mint is not kept, so
 * the next read asks again.
 * @param {() => Promise<unknown>} mint answers `{ token, expiresAt }`
 * @param {{ registerSecret?: (value: string) => unknown, now?: () => number }} [options]
 * @returns {() => Promise<string>}
 */
export function repositoryTokenHolder(mint, { registerSecret = () => {}, now = Date.now } = {}) {
  /** @type {Promise<{ token: string, expiresAt: string }> | null} */
  let held = null;
  const mintOnce = () => {
    const minting = mint().then((value) => {
      if (!isMintedToken(value)) throw new Error("The host answered no repository token.");
      registerSecret(value.token);
      return { token: value.token, expiresAt: value.expiresAt };
    });
    minting.catch(() => { if (held === minting) held = null; });
    return minting;
  };
  return async () => {
    held ??= mintOnce();
    const pending = held;
    const value = await pending;
    if (Date.parse(value.expiresAt) - now() >= REFRESH_MARGIN_MS) return value.token;
    if (held === pending) held = mintOnce();
    return (await held).token;
  };
}

/**
 * The repository's GitHub reads for one session: the MCP server as its data
 * source, exposed as `exposure` (pi-data-sources.mjs DataSource), and the
 * deployments tool beside it, both on `token`.
 * @param {{ owner: string, name: string }} repository
 * @param {() => Promise<string>} token
 * @param {{ exposure: "direct" | "deferred", onUnavailable: (reason: string) => void }} options
 * @returns {{ dataSource: import("./pi-data-sources.mjs").DataSource, tools: ReturnType<typeof deploymentsTool>[] }}
 */
export function githubSource(repository, token, { exposure, onUnavailable }) {
  return {
    dataSource: {
      name: GITHUB_SOURCE,
      description: "GitHub: the bound repository's code, commits, branches, pull requests, issues and Actions runs, read-only.",
      url: GITHUB_MCP_URL,
      headers: { ...GITHUB_HEADERS },
      exposure,
      token,
      onUnavailable,
    },
    tools: [deploymentsTool(repository, token)],
  };
}

/**
 * A lane's GitHub reads: one token for every session of the lane, minted by
 * `mint` and masked by `registerSecret` before anything holds it, and one
 * warning, `onUnavailable` hearing the first session whose server could not
 * be connected, and why.
 * @param {{ mint: () => Promise<unknown>, registerSecret?: (value: string) => unknown, onUnavailable: (reason: string) => void }} lane
 */
export function githubAccess({ mint, registerSecret, onUnavailable }) {
  const token = repositoryTokenHolder(mint, { registerSecret });
  let warned = false;
  /** @param {string} reason */
  const unavailable = (reason) => {
    if (warned) return;
    warned = true;
    onUnavailable(reason);
  };
  return {
    /**
     * One session's reads, or null when it names no repository.
     * @param {{ owner: string, name: string } | null | undefined} repository
     * @param {"direct" | "deferred"} exposure
     */
    source: (repository, exposure) => (repository ? githubSource(repository, token, { exposure, onUnavailable: unavailable }) : null),
  };
}
