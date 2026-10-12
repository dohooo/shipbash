// Result writing: the results the harness builds itself (a Cloudflare wall, a
// dead browser), the structured-result validator, auth-candidate retention,
// and the post-mortem diagnostics that explain a failed run after the
// container is gone.
import { stat, statfs, writeFile } from "node:fs/promises";
import { freemem, loadavg, totalmem } from "node:os";

import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";
import { activityKnowledgeSurface } from "@shipbash/contracts/runtime/discovery-surface.mjs";
import { createActivityResultContract } from "@shipbash/contracts/runtime/activity-result-contract.mjs";

import {
  AUTH_CANDIDATE_PATH,
  AUTH_CANDIDATE_READY_PATH,
  AUTH_ROOT,
  OUTPUT_ROOT,
  RESULT_PATH,
  validateActivity,
} from "./environment.mjs";
import { selectResultText } from "./pi-result.mjs";
import { redactSensitiveRuntimeValues, redactString, safeError } from "./redaction.mjs";
import { emit } from "./state.mjs";
import { saveActivityAuthCandidate } from "./sign-in-candidate.mjs";

export function cloudflareActivityResult(observation) {
  const recoveryAction = "Configure trusted Production access for this Project, then retry.";
  return {
    status: "needs_attention",
    authState: "unknown",
    summary: "Cloudflare security verification blocked access to the Production product.",
    publicMarkdown: "Cloudflare security verification blocked access to the Production product. Configure trusted Production access for this Project, then retry discovery.",
    visitedUrls: [observation.url],
    proposals: [],
    auth: null,
    attentionCode: "cloudflare_challenge",
    recoveryAction,
  };
}

/** The original browser connection could not be verified after bounded retries. */
export function browserLifecycleFaultResult(message, productionUrl) {
  const summary = `${message} ShipBash stopped this Activity because it could not verify the original browser connection.`;
  return {
    status: "needs_attention",
    authState: "unknown",
    summary,
    publicMarkdown: summary,
    visitedUrls: [productionUrl],
    proposals: [],
    auth: null,
    attentionCode: null,
    recoveryAction: "Retry this Activity to start a fresh browser session.",
  };
}

/**
 * Boot artifacts (about:blank from a state-load open) and browser-internal
 * URLs are evidence noise, not the deliverable: dropping them before
 * validation keeps an honest report alive instead of failing the whole leg
 * on a URL scheme.
 * @param {Record<string, unknown>} rawResult @param {string} productionUrl
 */
export function sanitizeVisitedUrls(rawResult, productionUrl) {
  if (Array.isArray(rawResult?.visitedUrls)) {
    const webUrls = rawResult.visitedUrls.filter((url) => typeof url === "string" && /^https?:\/\//iu.test(url));
    rawResult.visitedUrls = webUrls.length > 0 ? webUrls : [productionUrl];
  }
  return rawResult;
}

const activityResultContract = createActivityResultContract({
  validateActivity,
  redactSensitiveRuntimeValues,
  redactString,
});
export const validateActivityResult = activityResultContract.validateActivityResult;

/**
 * What deliver_result holds a delivery to (pi-result.mjs deliverResultTool):
 * the document the round would end on, read the way the round's end reads
 * the result file. Throws the Activity result contract's own message.
 * @param {Record<string, any>} activity
 */
export function deliveryCheck(activity) {
  return (document) => validateActivityResult(
    sanitizeVisitedUrls(JSON.parse(selectResultText(document, null, [], activity)), activity.productionUrl),
    activity,
  );
}

export async function nonEmptyFile(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

/** The agent-browser post-mortem a failed command left on its error, if any. */
function childDiagnostics(error) {
  return isRecord(error?.diagnostics) ? error.diagnostics : {};
}

/**
 * The sentence the "Activity runtime failed" warning carries. A failed child
 * command keeps its own error field on the thrown error's diagnostics —
 * "Navigation failed: net::ERR_CONNECTION_REFUSED" — and that is usually the
 * whole story, so it rides in the sentence instead of being lost behind the
 * constant "did not complete".
 */
export function runtimeFailureMessage(error) {
  const message = safeError(error);
  const cause = childDiagnostics(error).responseError;
  if (typeof cause !== "string" || !cause.trim()) return message;
  return `${message.replace(/\.\s*$/u, "")} (${cause.trim()}).`;
}

/**
 * Small, safe post-mortem snapshot for the "Activity runtime failed" warning:
 * the child command's post-mortem when there is one, the redacted error, and
 * memory and disk headroom at the moment of failure, so a production failure
 * explains itself without sandbox log access.
 */
export async function runtimeFailureDiagnostics(error) {
  // The child's fields first, so they can never displace the runtime's own.
  const diagnostics = { ...childDiagnostics(error), category: "runtime", error: safeError(error) };
  if (error instanceof Error && typeof error.stack === "string") {
    diagnostics.stack = redactString(error.stack, 500);
  }
  try {
    diagnostics.rssMb = Math.round(process.memoryUsage().rss / 1_048_576);
    diagnostics.freeMemMb = Math.round(freemem() / 1_048_576);
    diagnostics.totalMemMb = Math.round(totalmem() / 1_048_576);
    diagnostics.load1m = Math.round(loadavg()[0] * 100) / 100;
  } catch {
    // Telemetry must never mask the original failure.
  }
  try {
    const disk = await statfs(OUTPUT_ROOT);
    diagnostics.diskFreeMb = Math.round((disk.bavail * disk.bsize) / 1_048_576);
    diagnostics.diskTotalMb = Math.round((disk.blocks * disk.bsize) / 1_048_576);
  } catch {
    // Telemetry must never mask the original failure.
  }
  return diagnostics;
}

/**
 * What the retention command itself reported: the command line, how it ended,
 * and the error it named. Every field reads null when there is no post-mortem.
 * @param {Record<string, unknown> | null} diagnostics
 */
function authCommandDiagnostics(diagnostics) {
  return {
    authCommand: diagnostics?.command ?? null,
    authExitCode: diagnostics?.exitCode ?? null,
    authSignal: diagnostics?.signal ?? null,
    authTimedOut: diagnostics?.timedOut ?? null,
    authDurationMs: diagnostics?.durationMs ?? null,
    authResponseError: diagnostics?.responseError ?? null,
  };
}

/**
 * What was true when retention failed: the agent-browser post-mortem plus the
 * on-disk facts that decide whether the state ever reached us. Values are
 * booleans and sizes — never the state itself, never the encryption key.
 */
export async function authPersistenceDiagnostics(error, env) {
  const fileBytes = async (path) => (await stat(path).catch(() => null))?.size ?? -1;
  const [plainBytes, encryptedBytes, readyBytes, authRootIsDirectory] = await Promise.all([
    fileBytes(AUTH_CANDIDATE_PATH),
    fileBytes(`${AUTH_CANDIDATE_PATH}.enc`),
    fileBytes(AUTH_CANDIDATE_READY_PATH),
    stat(AUTH_ROOT).then((info) => info.isDirectory(), () => false),
  ]);
  const diagnostics = error?.diagnostics ?? null;
  // safeData accepts only flat primitives and at most 20 keys.
  return {
    ...authCommandDiagnostics(diagnostics),
    authStderrTail: diagnostics?.stderrTail || null,
    encryptionKeyPresent: Boolean(env.AGENT_BROWSER_ENCRYPTION_KEY),
    authRootIsDirectory,
    // -1 means the file is absent; 0 means it was created empty.
    candidatePlainBytes: plainBytes,
    candidateEncryptedBytes: encryptedBytes,
    candidateReadyBytes: readyBytes,
  };
}

/**
 * The leg-end writeback gate. Every leg that used a sign-in state (loaded the
 * saved one or a handoff's capture) or produced one (the agent filed a request
 * and the person signed in on this browser) hands its browser's state to the
 * candidate judge when it ends, so rotated cookies and a renewed session reach
 * the host instead of dying with the container. The agent's authState only
 * says whether the leg stopped at a sign-in wall: a leg that ended
 * unauthenticated (parked on a request, or auth_required) keeps the old state
 * and says so. It never proves the session alive — the pi lane reports
 * "unknown" for every completed round — so "unknown" and "authenticated"
 * alike go to the judge (sign-in-candidate.mjs): the regression guard against
 * the state the leg loaded, then the product-page ruler. A leg with no state
 * in play has nothing to write and says nothing.
 *
 * @param {Record<string, string | undefined>} env The agent-browser environment.
 * @param {string} productionUrl The product URL the Activity opened on.
 * @param {{ result: { authState: string }, authStatePath: string | null, handoff: boolean }} leg
 *   What the leg ended with, the state it loaded, and whether the agent filed a sign-in request.
 * @param {{ retain: typeof retainAuthCandidate }} [io] The retention step; a fake may be handed in.
 * @returns {Promise<boolean>} Whether candidate.ready was written for the host.
 */
export async function retainSignInState(env, productionUrl, { result, authStatePath, handoff }, io = { retain: retainAuthCandidate }) {
  if (authStatePath === null && !handoff) return false;
  const source = handoff ? "handoff" : "leg_end";
  if (result.authState === "unauthenticated") {
    emit("evidence", "Sign-in state not written", {
      safeData: { event: "sign_in_state_not_written", reason: "not_authenticated", source },
    });
    return false;
  }
  return io.retain(env, productionUrl, { source, authStatePath });
}

/** Retains the sign-in candidate; returns whether it is ready for the host. */
export async function retainAuthCandidate(env, productionUrl, context = {}) {
  try {
    return await saveActivityAuthCandidate(env, productionUrl, context);
  } catch (error) {
    emit("warning", "Authentication state could not be retained", {
      bodyMarkdown: safeError(error),
      safeData: {
        event: "sign_in_state_not_written",
        reason: "save_failed",
        source: context.source ?? "leg_end",
        category: "authentication_persistence",
        // Sign-in reuse is the difference between unattended verification
        // and asking the user to log in every night. When it fails the
        // Activity still succeeds, so this snapshot is the only chance to
        // learn why.
        ...(await authPersistenceDiagnostics(error, env)),
      },
    });
    return false;
  }
}

/** Writes and narrates the harness-built Cloudflare wall result. */
export async function publishCloudflareBlocked(challenge) {
  const result = cloudflareActivityResult(challenge);
  await writeFile(RESULT_PATH, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  emit("warning", "Cloudflare verification blocked Production access", {
    bodyMarkdown: result.recoveryAction,
    safeData: {
      status: "needs_attention",
      attentionCode: result.attentionCode,
      pageTitle: challenge.title,
      pageUrl: challenge.url,
    },
  });
  emit("result", "ShipBash needs attention", {
    bodyMarkdown: result.publicMarkdown,
    safeData: { status: "needs_attention", attentionCode: result.attentionCode },
  });
}

/**
 * Writes the validated result and narrates it: the prepared-result milestone,
 * one event per visible candidate case, and the agent's public message when
 * no progress update already carried it verbatim.
 */
export async function publishActivityOutcome({ result, runtimeInstance, activityStartedAt, authHandoffCount, publicMessages, activityKind = null }) {
  await writeFile(RESULT_PATH, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  emit("result", "Activity result prepared", {
    safeData: {
      event: "activity_result_prepared",
      status: result.status,
      runtimeInstance,
      durationMs: Date.now() - activityStartedAt,
      visitedUrlCount: result.visitedUrls.length,
      proposalCount: result.proposals.length,
      authHandoffs: authHandoffCount,
    },
  });
  // A kind that converses narrated every Journey live through journey_upsert
  // events; a second per-case dump at the end would only duplicate the timeline.
  const narratedLive = activityKnowledgeSurface(activityKind).interacts;
  for (const [proposalIndex, proposal] of (narratedLive ? [] : result.proposals).entries()) {
    const visibleCases = proposal.candidateDefinition.filter((candidate) =>
      !candidate.archived && candidate.change !== "archive");
    for (const [caseIndex, candidate] of visibleCases.entries()) {
      emit("result", "Candidate test case", {
        bodyMarkdown: candidate.steps,
        safeData: {
          event: "proposal_case",
          phase: "final",
          candidateId: candidate.id ?? `final-${String(proposalIndex + 1)}-${String(caseIndex + 1)}`,
          title: candidate.title,
          proposalIndex,
        },
      });
    }
  }
  if (!publicMessages.has(result.publicMarkdown.trim())) {
    emit("result", "Agent response", {
      bodyMarkdown: result.publicMarkdown,
      safeData: { event: "agent_output", phase: "final", status: result.status },
    });
  }
}
