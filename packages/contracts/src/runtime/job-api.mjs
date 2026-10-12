/**
 * The job API's wire format, both halves: the one client, shared by the
 * Sandbox's executor and its runner (task-api.mjs) and by
 * the local lane's runner against the host's per-run broker; and the
 * envelope every host serves it in (control-plane job-api/server.ts, the
 * runner's task-broker.mjs). Every call is `POST <endpoint>/<method>` with
 * the method's arguments as a gzipped JSON array; the answer is
 * `{"result": …}` or `{"ok": false, "error", "message"}`.
 *
 * In a Vercel Sandbox the endpoint is jobApiOrigin() and the call carries no
 * credential: the Sandbox firewall's forward rule adds the Vercel-signed
 * identity of the Sandbox on its way to the console (job-api/identity.ts). On
 * the local lane the broker hands its runner a bearer token instead.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import { AGENT_WRITE_TOOLS } from "./agent-data-contract.mjs";

export { JOB_API_HOST_VARIABLE, jobApiForwardUrl, jobApiHost, jobApiOrigin } from "./job-api-contract.mjs";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** What the worker's lease-lost paths read: the store's own sentence, whichever side refused. */
export const JOB_LEASE_LOST = "Dispatch Job lease is invalid, expired, or already released.";

/** Where the runner finds its task API: a 0600 file on its control mount, read and removed on start. */
export const TASK_API_CONFIG_FILE = "task-api.json";
/** The methods the runner side calls: a local broker serves exactly these. */
export const TASK_API_METHODS = Object.freeze(["credentialsRead", "credentialsOutcome", "agentTool", "repositoryToken"]);

/**
 * How each method may be sent again, declared once for every caller.
 * `safe`: it changes nothing, or changes it the same way twice, so it is
 * resent after any transient failure. `once`: a write, resent only when the
 * request provably never left. `heartbeat`: safe, on a shorter attempt, so a
 * lease that cannot be renewed is known well inside its 120 s.
 */
export const JOB_METHOD_RETRY = Object.freeze({
  claimDispatchJob: "safe",
  heartbeatDispatchJob: "heartbeat",
  isDispatchCancellationRequested: "safe",
  loadDispatchExecutionInput: "safe",
  appendRunEventsForJob: "once",
  appendActivityEventsForJob: "once",
  startCaseRunForJob: "once",
  updateCaseChecklistForJob: "once",
  updateCaseTrustForJob: "once",
  completeCaseRunForJob: "once",
  completeActivityForJob: "once",
  createProposalForJob: "once",
  recordKnowledgeEntryForJob: "once",
  saveActivityAgentSessionForJob: "once",
  markActivityWaitingForInputForJob: "once",
  markActivityRunningAfterInputForJob: "once",
  withdrawActivityQuestionForJob: "once",
  withdrawOpenActivityQuestionForJob: "once",
  markActivityInlineAuthWaitingForJob: "once",
  markActivityInlineAuthRunningForJob: "once",
  releaseDispatchJobWaitingForAuth: "once",
  markTargetAuthProfileExpiredForJob: "once",
  markTargetAuthProfileFailedForJob: "once",
  markDispatchFinalizationFailed: "once",
  completeDispatchJob: "once",
  failDispatchJob: "once",
  cancelDispatchJob: "once",
  drawWorkProgress: "once",
  trustedAccess: "safe",
  signInOpen: "safe",
  credentialsList: "safe",
  credentialsRead: "safe",
  repositoryToken: "safe",
  signInKeep: "once",
  credentialsOutcome: "once",
  uploadsPrepare: "safe",
  recordingPrepare: "safe",
  uploadsSettle: "once",
  recordingSettle: "once",
  activityOpening: "safe",
  suiteOpening: "safe",
  agentTool: "safe",
});

/**
 * A call's retry class: its method's, except that an agentTool call to a tool
 * that writes (agent-data-contract.mjs AGENT_WRITE_TOOLS) is a write.
 * @param {keyof typeof JOB_METHOD_RETRY} method @param {readonly unknown[]} args
 */
function retryClassOf(method, args) {
  const tool = args[0];
  const writes = method === "agentTool" && tool !== null && typeof tool === "object" && "name" in tool
    && AGENT_WRITE_TOOLS.some((name) => name === tool.name);
  return writes ? "once" : JOB_METHOD_RETRY[method];
}

const RETRY_CLASSES = Object.freeze({
  heartbeat: { resent: "always", timeoutMs: 10_000 },
  safe: { resent: "always", timeoutMs: 15_000 },
  once: { resent: "unsent", timeoutMs: 30_000 },
});
const BACKOFF_MS = Object.freeze([500, 1_000, 2_000]);
// A connect that failed before a byte was written: even a write may be sent again.
const UNSENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
const RETRIED_STATUSES = new Set([408, 429]);

/** The one cap on a call's body, inflated: Vercel's own 4.5 MB applies to the wire bytes first. */
export const MAX_JOB_BODY_BYTES = 16 * 1024 * 1024;

const TOO_LARGE = Object.freeze({ status: 413, error: "JOB_BODY_TOO_LARGE", message: "The request body is too large." });
const FAILED = Object.freeze({ status: 500, error: "JOB_API_FAILED", message: "The request could not be completed." });

/**
 * Writes the task API's address for the runner. Answers the file's path, or
 * null when there is no task API to name.
 * @param {string} directory
 * @param {{ endpoint: string, token: string | null, signIns: unknown[] } | undefined} config
 */
export async function writeTaskApiConfig(directory, config) {
  if (!config) return null;
  const path = join(directory, TASK_API_CONFIG_FILE);
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  return path;
}

/** JSON drops a trailing `undefined` argument as `null`; the method's own default must apply instead. */
function wireArguments(args) {
  const sent = [...args];
  while (sent.length > 0 && sent.at(-1) === undefined) sent.pop();
  return sent;
}

function refusal(status, payload) {
  if (status === 401) return new Error(JOB_LEASE_LOST);
  const message = typeof payload?.message === "string" && payload.message ? payload.message : `The job API answered HTTP ${status}.`;
  return new Error(message);
}

function parsedOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * One request: its answer, or why it has none and whether it provably never
 * left. The status decides first: a platform's own 5xx or 429 is plain text,
 * and is as transient as ours. Only an answer that should have been ours —
 * a 2xx, or another 4xx such as a login page or a rolled-back deployment's
 * 404 — is fatal without JSON.
 */
async function attempt(url, headers, body, timeoutMs) {
  let response;
  let text;
  try {
    response = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
    text = await response.text();
  } catch (error) {
    const code = error?.cause?.code ?? error?.code;
    return { kind: "network", error, unsent: !response && UNSENT_CODES.has(code) };
  }
  const payload = parsedOrNull(text);
  const { status } = response;
  if (!response.ok && (RETRIED_STATUSES.has(status) || status >= 500)) {
    return { kind: "transient", status, error: refusal(status, payload) };
  }
  if (payload === null) return { kind: "fatal", error: new Error(`The job API answered HTTP ${status} without JSON.`) };
  if (response.ok) return { kind: "ok", result: payload.result };
  return { kind: "fatal", error: refusal(status, payload) };
}

function retriable(outcome, resent) {
  if (outcome.kind === "network") return resent === "always" || outcome.unsent;
  return outcome.kind === "transient" && resent === "always";
}

function failure(outcome) {
  if (outcome.kind !== "network") return outcome.error;
  return new Error(`The job API could not be reached: ${outcome.error?.message ?? String(outcome.error)}`, { cause: outcome.error });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms + Math.random() * (ms / 2)));

/**
 * @param {{ endpoint: string, token?: string }} options
 */
export function createJobApiClient({ endpoint, token }) {
  const origin = endpoint.replace(/\/+$/u, "");
  const headers = {
    "content-type": "application/json",
    "content-encoding": "gzip",
    "accept-encoding": "gzip",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  return {
    /**
     * @param {keyof typeof JOB_METHOD_RETRY} method
     * @param {readonly unknown[]} args
     */
    async call(method, args) {
      const retry = Object.hasOwn(JOB_METHOD_RETRY, method) ? RETRY_CLASSES[retryClassOf(method, args)] : undefined;
      if (!retry) throw new Error(`No job API method is named ${method}.`);
      const body = await gzipAsync(Buffer.from(JSON.stringify(wireArguments(args))));
      for (let tries = 0; ; tries += 1) {
        const outcome = await attempt(`${origin}/${method}`, headers, body, retry.timeoutMs);
        if (outcome.kind === "ok") return outcome.result;
        if (!retriable(outcome, retry.resent) || tries >= BACKOFF_MS.length) throw failure(outcome);
        await pause(BACKOFF_MS[tries]);
      }
    },
  };
}

function invalidBody(message) {
  return { status: 400, error: "JOB_BODY_INVALID", message };
}

/**
 * A call's arguments from its body, read under the one cap and inflated
 * under it again: a JSON array, or the refusal that says why there is none.
 * @param {AsyncIterable<Uint8Array> | null} body
 * @param {string | null | undefined} contentEncoding
 */
export async function readJobApiArguments(body, contentEncoding) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_JOB_BODY_BYTES) return TOO_LARGE;
    chunks.push(chunk);
  }
  let raw = Buffer.concat(chunks);
  if (contentEncoding === "gzip") {
    try {
      raw = await gunzipAsync(raw, { maxOutputLength: MAX_JOB_BODY_BYTES });
    } catch (error) {
      return error instanceof RangeError ? TOO_LARGE : invalidBody("The request body is not valid gzip.");
    }
  }
  const args = parsedOrNull(raw.toString("utf8"));
  return Array.isArray(args) ? { args } : invalidBody("The request body is not a JSON array.");
}

export function unknownJobMethod(name) {
  return { status: 404, error: "JOB_METHOD_UNKNOWN", message: `This API serves no method named ${name}.` };
}

/**
 * How a method's failure is answered, by every host alike: arguments a
 * schema refused are a bad body; a plain Error keeps its own words — the
 * store's, which the worker read before there was an API (Dispatch Job lease
 * is invalid…, Case Run is outside…); anything else is the host's failure.
 */
export function jobApiFailure(error) {
  if (error?.name === "ZodError" && Array.isArray(error.issues)) {
    const issue = error.issues[0];
    const where = issue?.path?.length ? ` at ${issue.path.join(".")}` : "";
    return invalidBody(`The arguments are invalid${where}: ${issue?.message ?? "unknown reason"}`);
  }
  if (error instanceof Error && error.constructor === Error) return { status: 422, error: "JOB_REFUSED", message: error.message };
  return FAILED;
}

/**
 * The answer to a call in the envelope, gzipped when the caller takes gzip:
 * `{"result": …}` with 200, or the refusal with its own status.
 * @param {string | null | undefined} acceptEncoding
 * @param {{ result: unknown } | { status: number, error: string, message: string }} outcome
 */
export async function jobApiAnswer(acceptEncoding, outcome) {
  const status = "result" in outcome ? 200 : outcome.status;
  const value = "result" in outcome ? { result: outcome.result } : { ok: false, error: outcome.error, message: outcome.message };
  const json = Buffer.from(JSON.stringify(value));
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  if (!/\bgzip\b/u.test(acceptEncoding ?? "")) return { status, headers, body: json };
  return { status, headers: { ...headers, "content-encoding": "gzip" }, body: await gzipAsync(json) };
}
