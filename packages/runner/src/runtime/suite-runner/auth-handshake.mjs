// The suite side of the human-auth handshake: sentinel files from the
// control mount, the wait loop a parked case sits in, and where candidate
// and canonical auth state live on disk. The human-auth viewer produces the
// candidate; this lane only ever consumes it.
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  AUTH_CANCEL_PATH,
  AUTH_CANDIDATE_PATH,
  AUTH_CANDIDATE_READY_PATH,
  AUTH_COMPLETE_PATH,
  AUTH_STATE_PATH,
} from "./environment.mjs";
import { checkCancellation, emit } from "./state.mjs";
import { existingStateFile } from "../browser-state-seal.mjs";

export async function consumeManualAuthComplete() {
  if (!existsSync(AUTH_COMPLETE_PATH)) {
    return false;
  }
  await unlink(AUTH_COMPLETE_PATH).catch(() => {});
  return true;
}

export async function consumeManualAuthCancel() {
  if (!existsSync(AUTH_CANCEL_PATH)) {
    return false;
  }
  await unlink(AUTH_CANCEL_PATH).catch(() => {});
  return true;
}

export async function waitForAuthentication(
  caseRunId,
  attempt,
  validationRound,
  deadline,
  timeoutMs,
) {
  let lastHeartbeat = 0;
  const context = { caseRunId, attempt, validationRound };
  emit("case", "waiting_for_auth", {
      ...context,
      timeoutMs,
      message:
        "Complete sign-in in the isolated human authentication viewer, then choose I’m done. The Agent browser remains stopped during credential entry.",
    });

    while (true) {
      checkCancellation();
      if (await consumeManualAuthCancel()) {
        emit("case", "auth_takeover_canceled", {
          ...context,
          message: "The user canceled authentication takeover for this Case.",
        });
        return "auth_takeover_canceled";
      }
      if (Date.now() >= deadline) {
        emit("case", "auth_takeover_timed_out", {
          ...context,
          timeoutMs,
          message: "Authentication takeover timed out before a verified signed-in state was available.",
        });
        return null;
      }
      const manual = await consumeManualAuthComplete();
      if (manual) {
        // The human-auth viewer captured the signed-in state over CDP; this
        // lane only has to find the candidate it left behind. No browser
        // opens against a shared profile here — there is none.
        const candidatePath = await waitForCapturedCandidate(30_000);
        if (!candidatePath) {
          emit("infrastructure", "auth_candidate_missing", {
            ...context,
            message: "Authentication finished but no captured sign-in state arrived; the takeover must be restarted.",
          });
          return null;
        }
        await unlink(AUTH_CANDIDATE_READY_PATH).catch(() => {});
        emit("case", "auth_candidate_detected", {
          ...context,
          detection: "human_viewer_complete",
        });
        return candidatePath;
      }
      if (Date.now() - lastHeartbeat > 30_000) {
        emit("case", "waiting_for_auth", {
          ...context,
          message: "Authentication is still waiting for the user to finish in the isolated viewer.",
        });
        lastHeartbeat = Date.now();
      }
      await delay(500);
  }
}

/**
 * The captured candidate is produced by the human-auth viewer container and
 * arrives through the shared auth mount. The ready marker seals the pair:
 * candidate bytes without it may still be mid-write.
 */
export async function waitForCapturedCandidate(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidatePath = existingStateFile(AUTH_CANDIDATE_PATH);
    if (candidatePath && existsSync(AUTH_CANDIDATE_READY_PATH)) return candidatePath;
    await delay(250);
  }
  return null;
}

export function existingAuthStatePath() {
  return existingStateFile(AUTH_STATE_PATH);
}
