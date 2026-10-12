/**
 * Who calls the job API: one Vercel Sandbox, identified by the token the
 * Sandbox firewall's forward rule signs for it (server.ts verifies it with
 * the SDK's `defineSandboxProxy`), and the one job that Sandbox runs. The
 * whole VM is the caller — executor, runner and agent alike — and it is
 * served only while its job is leased and live: the job row is the clock,
 * not the token's 24 hours.
 */
import { getVercelOidcToken } from "@vercel/oidc";
import type { ProxyMeta } from "@vercel/sandbox/proxy";
import { decodeJwt, errors } from "jose";

import { isRecord } from "../is-record.ts";
import type { JobStore } from "../store/job-store.ts";
import { vercelSandboxWorkspaceName } from "../vercel-sandbox-dispatch/workspace-names.ts";
import type { JobContext } from "./define.ts";

/** The Vercel team and project a deployment runs as: the only owner whose Sandboxes may call it. */
export interface DeploymentIdentity {
  teamId: string;
  projectId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

let deployment: Promise<DeploymentIdentity> | null = null;

/**
 * Read once per process from the deployment's own OIDC token: its owner and
 * project never change while it runs. The SDK accepts a Sandbox of any team
 * (defineSandboxProxy checks only that Vercel signed the token), so this is
 * what keeps every other team's Sandboxes out.
 */
export function vercelDeploymentIdentity(): Promise<DeploymentIdentity> {
  deployment ??= readDeploymentIdentity().catch((error: unknown) => {
    deployment = null;
    throw error;
  });
  return deployment;
}

async function readDeploymentIdentity(): Promise<DeploymentIdentity> {
  const claims = decodeJwt(await getVercelOidcToken());
  if (typeof claims.owner_id !== "string" || !claims.owner_id || typeof claims.project_id !== "string" || !claims.project_id) {
    throw new Error("The deployment's OIDC token names no owner or project.");
  }
  return { teamId: claims.owner_id, projectId: claims.project_id };
}

/** Whether a Sandbox's verified identity belongs to this deployment's own team and project. */
export function ownSandbox(meta: ProxyMeta, owner: DeploymentIdentity): boolean {
  return meta.teamId === owner.teamId && meta.projectId === owner.projectId;
}

/**
 * Why the proxy refused a request, as the API answers it: Vercel's key set
 * that could not be fetched — an answer that was not 200 or not JSON, a
 * timeout, a network that failed — is the API being unavailable, and the
 * Sandbox asks again; anything else is an identity it cannot accept.
 */
export function identityFailureStatus(error: Error): 401 | 503 {
  if (error instanceof errors.JOSEError) {
    return error.code === errors.JOSEError.code || error.code === errors.JWKSTimeout.code ? 503 : 401;
  }
  return error instanceof TypeError && isRecord(error.cause) && typeof error.cause.code === "string" ? 503 : 401;
}

/**
 * The job a Sandbox's call is served for, or null. The Sandbox's name must
 * be the one its reservation was launched under: a re-dispatched job has a
 * new reservation and so a new name, which refuses the old Sandbox. Every
 * method but the claim also needs the reservation already claimed.
 */
export async function leasedJobCaller(
  jobs: Pick<JobStore, "readLeasedDispatchJob">,
  input: { jobId: string; sandboxName: string; claim: boolean },
): Promise<Pick<JobContext, "capability" | "job"> | null> {
  if (!UUID.test(input.jobId)) return null;
  const leased = await jobs.readLeasedDispatchJob(input.jobId);
  if (!leased) return null;
  const { capability, job } = leased;
  const name = vercelSandboxWorkspaceName({ projectId: job.projectId, jobId: job.id, dispatchAttemptId: capability.leaseToken });
  if (name !== input.sandboxName) return null;
  if (!input.claim && !leased.claimed) return null;
  return { capability, job };
}
