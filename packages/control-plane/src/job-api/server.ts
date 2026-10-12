/**
 * `POST /api/jobs/<jobId>/<method>`: the job API as a Fetch handler, mounted
 * by the console and by the local service. A Sandbox reaches it through its
 * firewall's forward rule (`SHIPBASH_JOB_API_HOST` → this route), which signs
 * the Sandbox's identity on the way. Who is calling is settled before the
 * body is read: the Vercel token, this deployment's own team and project, a
 * method the registry declares, and the job that Sandbox runs, still leased.
 * The envelope — the body's cap, the answer, how a failure is answered — is
 * the contracts' (job-api.mjs), shared with the local lane's broker. The
 * token is never logged; a log line names the job, the Sandbox, the method
 * and the status.
 */
import {
  jobApiAnswer,
  jobApiFailure,
  jobApiForwardUrl,
  type JobApiFailure,
  readJobApiArguments,
  unknownJobMethod,
} from "@shipbash/contracts/runtime/job-api.mjs";
import { defineSandboxProxy, type ProxyMeta } from "@vercel/sandbox/proxy";
import postgres from "postgres";

import type { AnyJobMethod, JobApiResources, JobContext } from "./define.ts";
import { type DeploymentIdentity, identityFailureStatus, leasedJobCaller, ownSandbox } from "./identity.ts";
import { jobMethod } from "./registry.ts";

const TRANSIENT_SQLSTATE_CLASSES = new Set(["08", "40", "53", "57"]);
const CONNECTION_CODES = new Set(["CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED"]);

export interface JobApiDeps extends JobApiResources {
  deploymentIdentity(): Promise<DeploymentIdentity>;
}

export interface JobApiRoute {
  jobId: string;
  method: string;
}

type Outcome = { result: unknown } | JobApiFailure;

const identityRefused: JobApiFailure = { status: 401, error: "JOB_IDENTITY_INVALID", message: "The caller is not this job's Sandbox." };
const unavailable: JobApiFailure = { status: 503, error: "JOB_API_UNAVAILABLE", message: "The job API is temporarily unavailable." };
const failed: JobApiFailure = { status: 500, error: "JOB_API_FAILED", message: "The request could not be completed." };

async function answer(request: Request, outcome: Outcome): Promise<Response> {
  const { status, headers, body } = await jobApiAnswer(request.headers.get("accept-encoding"), outcome);
  return new Response(body, { status, headers });
}

/** A refusal, logged once: the job, the Sandbox, the method, the status and why — never the token. */
function refusal(request: Request, route: JobApiRoute, sandboxName: string | null, failure: JobApiFailure, cause?: unknown): Promise<Response> {
  const reason = cause instanceof Error ? cause.message : undefined;
  const line = JSON.stringify({ scope: "job_api", jobId: route.jobId, sandboxName, method: route.method, status: failure.status, error: failure.error, reason });
  if (failure.status >= 500) console.error(line, cause);
  else console.warn(line);
  return answer(request, failure);
}

function transient(error: unknown): boolean {
  if (error instanceof postgres.PostgresError) return TRANSIENT_SQLSTATE_CLASSES.has(error.code.slice(0, 2));
  if (error instanceof Error && error.name === "TimeoutError") return true;
  const code = error instanceof Error && "code" in error ? error.code : null;
  return typeof code === "string" && CONNECTION_CODES.has(code);
}

/**
 * The method itself, and its refusal in the envelope's terms. The server's
 * own failure — transient, or anything that is not a refusal — is thrown, to
 * be logged and answered 503 or 500.
 */
async function ran(method: AnyJobMethod, context: JobContext, args: unknown[]): Promise<Outcome> {
  try {
    return { result: await method.run(context, ...args) };
  } catch (error) {
    const failure = jobApiFailure(error);
    if (transient(error) || failure.status >= 500) throw error;
    return failure;
  }
}

async function served(request: Request, meta: ProxyMeta, route: JobApiRoute, deps: JobApiDeps): Promise<Outcome> {
  if (!ownSandbox(meta, await deps.deploymentIdentity())) return identityRefused;
  const method = jobMethod(route.method);
  if (!method) return unknownJobMethod(route.method);
  const caller = await leasedJobCaller(deps.store.jobs, {
    jobId: route.jobId, sandboxName: meta.sandboxName, claim: route.method === "claimDispatchJob",
  });
  if (!caller) return identityRefused;
  const body = await readJobApiArguments(request.body, request.headers.get("content-encoding"));
  if (!("args" in body)) return body;
  const parsed = method.args.safeParse(body.args);
  if (!parsed.success) return jobApiFailure(parsed.error);
  return ran(method, { ...deps, ...caller }, parsed.data);
}

async function serve(request: Request, meta: ProxyMeta, route: JobApiRoute, deps: JobApiDeps): Promise<Response> {
  let outcome: Outcome;
  try {
    outcome = await served(request, meta, route, deps);
  } catch (error) {
    return refusal(request, route, meta.sandboxName, transient(error) ? unavailable : failed, error);
  }
  if ("result" in outcome) return answer(request, outcome);
  return refusal(request, route, meta.sandboxName, outcome);
}

export async function handleJobApiRequest(request: Request, route: JobApiRoute, deps: JobApiDeps): Promise<Response> {
  // The token's audience is the forward URL on the configured origin, never
  // on whatever host the request names: rebuild the URL from the route.
  const url = new URL(`${jobApiForwardUrl(deps.publicOrigin, route.jobId)}/${encodeURIComponent(route.method)}`);
  const verified = defineSandboxProxy(
    (sanitized, meta) => serve(sanitized, meta, route, deps),
    (_request, error) => refusal(request, route, null, identityFailureStatus(error) === 503 ? unavailable : identityRefused, error),
  );
  return verified(new Request(url, request));
}
