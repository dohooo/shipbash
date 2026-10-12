/**
 * github_list_deployments: the bound repository's deployments, which GitHub's
 * MCP server has no tool for, read over GitHub's REST API with the same
 * repository token (github-source.mjs). One list read, newest first, then one
 * read of each deployment's latest status. Read-only, like every GitHub read.
 * pi holds each call's arguments to the tool's schema before it runs.
 */
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

const API_ORIGIN = "https://api.github.com";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
const TIMEOUT_MS = 60_000;
export const DEPLOYMENTS_TOOL_NAME = "github_list_deployments";

/** @param {Record<string, unknown>} args */
function deploymentsQuery({ environment, limit = DEFAULT_LIMIT }) {
  const query = new URLSearchParams({ per_page: String(limit) });
  if (typeof environment === "string") query.set("environment", environment);
  return query;
}

/**
 * @param {string} url
 * @param {{ token: string, signal: AbortSignal, fetch: typeof fetch }} request
 * @returns {Promise<unknown>}
 */
async function readJson(url, { token, signal, fetch }) {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "shipbash-runner",
      "x-github-api-version": "2022-11-28",
    },
    signal,
  });
  /** @type {unknown} */
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const said = isRecord(body) && typeof body.message === "string" ? `: ${body.message.slice(0, 200)}` : "";
    throw new Error(`GitHub answered HTTP ${String(response.status)}${said}.`);
  }
  return body;
}

/**
 * The deployments as JSON text, one entry each: sha, ref, environment,
 * created_at, state and environment_url (both null before any status).
 * @param {{ owner: string, name: string }} repository
 * @param {string} token
 * @param {Record<string, unknown>} args
 * @param {{ signal: AbortSignal, fetch?: typeof fetch }} options
 */
export async function listDeployments(repository, token, args, { signal, fetch = globalThis.fetch }) {
  const base = `${API_ORIGIN}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/deployments`;
  const request = { token, signal, fetch };
  const deployments = await readJson(`${base}?${deploymentsQuery(args).toString()}`, request);
  if (!Array.isArray(deployments)) throw new Error("GitHub answered no deployment list.");
  const entries = await Promise.all(deployments.map(async (deployment) => {
    if (!isRecord(deployment) || !Number.isSafeInteger(deployment.id)) throw new Error("GitHub answered a deployment without an id.");
    const statuses = await readJson(`${base}/${String(deployment.id)}/statuses?per_page=1`, request);
    const latest = Array.isArray(statuses) && isRecord(statuses[0]) ? statuses[0] : null;
    return {
      sha: deployment.sha ?? null,
      ref: deployment.ref ?? null,
      environment: deployment.environment ?? null,
      created_at: deployment.created_at ?? null,
      state: latest?.state ?? null,
      environment_url: latest?.environment_url || null,
    };
  }));
  return JSON.stringify(entries);
}

/**
 * The tool, reading `repository` with the token `token` answers at call time.
 * @param {{ owner: string, name: string }} repository
 * @param {() => Promise<string>} token
 * @param {{ fetch?: typeof fetch }} [options]
 */
export function deploymentsTool(repository, token, { fetch = globalThis.fetch } = {}) {
  return {
    name: DEPLOYMENTS_TOOL_NAME,
    label: DEPLOYMENTS_TOOL_NAME,
    description: "List the repository's deployments on GitHub, newest first: each one's commit sha, ref, environment and creation time, with its latest status (state and environment_url). Read-only.",
    parameters: {
      type: "object",
      properties: {
        environment: { type: "string", minLength: 1, maxLength: 255, description: "Only deployments to this environment, as GitHub names it (for example Production)." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `How many deployments, newest first. Default ${String(DEFAULT_LIMIT)}.` },
      },
      additionalProperties: false,
    },
    executionMode: "parallel",
    /** @param {string} _toolCallId @param {Record<string, unknown> | undefined} params @param {AbortSignal | undefined} signal */
    execute: async (_toolCallId, params, signal) => {
      const bounded = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]);
      const text = await listDeployments(repository, await token(), params ?? {}, { signal: bounded, fetch });
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}
