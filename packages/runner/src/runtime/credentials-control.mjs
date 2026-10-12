/**
 * The saved sign-ins a run may read, field by field: each read is asked of
 * the task API (task-api.mjs), and every value it answers is registered for
 * masking before the agent receives it.
 */
import { credentialError } from "@shipbash/contracts/runtime/credential-contract.mjs";
import { JOB_LEASE_LOST } from "@shipbash/contracts/runtime/job-api.mjs";

import { holdScreencastBlackout } from "./screencast-blackout.mjs";
import { handedTaskApi } from "./task-api.mjs";
import { TOTP_STEP_SECONDS } from "./totp.mjs";

const TOTP_STEP_MS = TOTP_STEP_SECONDS * 1_000;

/**
 * When a handed-out code stops being worth hiding: one step past its expiry,
 * since RFC 6238 §5.2 lets a verifier accept the previous step's code. An
 * expiry that cannot be read fails closed: two steps from now outlast any
 * code the broker could have minted.
 * @param {{ expiresAt?: unknown }} totp
 * @param {number} [now]
 */
export function codeHiddenUntil(totp, now = Date.now()) {
  const expiresAt = typeof totp.expiresAt === "string" ? Date.parse(totp.expiresAt) : Number.NaN;
  return (Number.isFinite(expiresAt) ? expiresAt : now + TOTP_STEP_MS) + TOTP_STEP_MS;
}

/** Whether this run was handed a task API to read saved sign-ins through. */
export function credentialsAvailable() { return handedTaskApi() !== null; }
/** The saved sign-ins on offer to this run. */
export function availableSignIns() { return handedTaskApi()?.signIns ?? []; }

/** A credential read's answer: the values, or the credential error the agent can act on. */
async function readCredentials(client, request) {
  try {
    return await client.call("credentialsRead", [request]);
  } catch (error) {
    return credentialError(error?.message === JOB_LEASE_LOST ? "task_inactive" : "service_unavailable");
  }
}

/**
 * `registerSecrets` registers what a served sign-in carries and answers the
 * names of the values too short to mask; `onUnmasked` hears each such name
 * once, so the run can say which value its logs cannot hide.
 * @param {{ registerSecrets: (value: any) => string[], onUnmasked: (name: string) => void }} options
 */
export async function startCredentialControl({ registerSecrets, onUnmasked }) {
  const api = handedTaskApi();
  if (!api) return null;
  let running = true;
  let close = () => undefined;
  // A read still out when the run closes is answered no more.
  const closed = new Promise((resolve) => { close = () => resolve(credentialError("service_unavailable")); });
  const unmasked = new Set();
  let lastSignInId = null;
  /** @param {{ signInId: string, fields: string[] }} request */
  async function serve(request) {
    /** @type {any} The task API's answer: values, or a credential error. */
    const result = await readCredentials(api.client, request);
    if (!running) return credentialError("service_unavailable");
    if (api.signIns.some((entry) => entry?.id === request.signInId)) lastSignInId = request.signInId;
    for (const name of registerSecrets(result)) {
      if (!unmasked.has(name)) onUnmasked(name);
      unmasked.add(name);
    }
    // The agent types this code into the page, often a cell at a time: the
    // screen is hidden before the agent can read it, until no verifier would
    // take it any more.
    if (typeof result?.totp?.code === "string") holdScreencastBlackout(codeHiddenUntil(result.totp));
    return result;
  }
  return {
    /**
     * One read for the agent: the values, registered for masking and the
     * screen hidden for a code before they are answered, or the credential
     * error the agent can act on.
     * @param {{ signInId: string, fields: string[] }} request
     */
    read: (request) => Promise.race([serve(request), closed]),
    /** Whether this case asked for a saved sign-in's credentials, which is how it signs in itself. */
    fetchedCredentials: () => lastSignInId !== null,
    async reportOutcome(caseId, result, redact) {
      if (!running || !lastSignInId) return;
      if (result.authState !== "unauthenticated" && !(result.authState === "authenticated" && result.outcome === "passed")) return;
      const answer = await api.client.call("credentialsOutcome", [{
        caseId, signInId: lastSignInId, authenticated: result.authState === "authenticated",
        message: redact(result.failureReason ?? result.summary ?? "").slice(0, 1000),
      }]);
      if (!answer || typeof answer !== "object" || "error" in answer) throw new Error("Authentication outcome could not be recorded.");
    },
    async close() {
      running = false;
      close();
    },
  };
}
