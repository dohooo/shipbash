// The task API this runner was handed through its control root: the job API
// itself in a Vercel Sandbox, whose firewall signs every call so the runner
// holds no credential, or the local lane's broker, with the bearer it handed
// this run. It answers the record's read tools, mints the repository token,
// and serves the saved sign-ins on offer (credentials-control.mjs).
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";
import { TASK_API_CONFIG_FILE, createJobApiClient, jobApiOrigin } from "@shipbash/contracts/runtime/job-api.mjs";

// The local lane's broker is the host, reached through a Docker container's
// gateway, or the root side of a sign-in check beside this runner, on loopback.
const BROKER_HOSTS = new Set(["host.docker.internal", "127.0.0.1"]);

/** @type {{ client: ReturnType<typeof createJobApiClient>, signIns: Array<Record<string, unknown>> } | null} */
let taskApi = null;

/** The task API this runner was handed, with the sign-ins it offers; null without one. */
export function handedTaskApi() {
  return taskApi;
}

/**
 * Where the task API answers: the job API in a Vercel Sandbox, which the
 * Sandbox's firewall vouches for so the runner holds no credential; or the
 * local lane's broker, with the bearer it handed this run.
 */
function taskApiEndpoint(value) {
  if (value.token === null) {
    const origin = jobApiOrigin(process.env);
    if (value.endpoint === origin) return origin;
    throw new Error("Invalid task API config.");
  }
  const endpoint = new URL(value.endpoint);
  if (endpoint.protocol !== "http:" || !BROKER_HOSTS.has(endpoint.hostname) || endpoint.pathname !== "/"
    || [endpoint.username, endpoint.password, endpoint.search, endpoint.hash].some(Boolean) || !endpoint.port
    || typeof value.token !== "string" || value.token.length < 32) throw new Error("Invalid task API config.");
  return endpoint.origin;
}

/**
 * Takes the task API's address, token and accounts out of the control root.
 * A token is registered for masking before the agent can run anything.
 * @param {{ registerSecret: (value: unknown) => boolean, root?: string }} options
 */
export async function consumeTaskApiConfig({ registerSecret, root = process.env.SHIPBASH_CONTROL_ROOT ?? "/shipbash/control" }) {
  const path = join(root, TASK_API_CONFIG_FILE);
  let raw;
  try { raw = await readFile(path, "utf8"); } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  const value = JSON.parse(raw);
  if (!Array.isArray(value?.signIns)) throw new Error("Invalid task API config.");
  const endpoint = taskApiEndpoint(value);
  const token = value.token ?? undefined;
  if (token) registerSecret(token);
  taskApi = { client: createJobApiClient({ endpoint, token }), signIns: value.signIns };
  await rm(path);
  return true;
}

/**
 * The record's own answer to a read tool — recall_knowledge, a case's
 * record_knowledge, and the history beyond this run — asked of the task API's
 * agentTool. Null without a task API.
 * @param {string | null} caseId the case being walked, when there is one
 * @returns {((name: string, args: Record<string, unknown>) => Promise<string>) | null}
 */
export function agentDataCaller(caseId) {
  if (!taskApi) return null;
  const { client } = taskApi;
  return async (name, args) => {
    // The record's answer: the tool's text, or its own error.
    const answer = await client.call("agentTool", [{ name, args, caseId }]);
    if (isRecord(answer) && typeof answer.error === "string") throw new Error(answer.error);
    if (!isRecord(answer) || typeof answer.text !== "string") throw new Error("ShipBash's record gave no answer to the tool.");
    return answer.text;
  };
}

/**
 * A read-only token for the job's one repository, minted on the host per
 * request (job API `repositoryToken`), so no task holds the GitHub App key.
 * Its holder registers it for masking before using it (github-source.mjs).
 * @returns {Promise<unknown>}
 */
export async function mintRepositoryToken() {
  if (!taskApi) throw new Error("This run has no task API to mint a repository token through.");
  return taskApi.client.call("repositoryToken", []);
}
