/**
 * What a host needs to run a sign-in leg, whichever host it is — the local
 * service starting a Docker container, or the hosted check's root side in a
 * Sandbox (sign-in-check.mjs): the environment the leg runs with, and how its
 * outcome is read off its output.
 */
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

/**
 * The leg's browser identity and output limits. Each host adds the rest
 * itself: the model and Jev keys, and where the leg's files live.
 * @param {{ mode: "sign-in-verify" | "sign-in-login", projectHash: string }} leg
 * @returns {Record<string, string>}
 */
export function signInLegEnvironment({ mode, projectHash }) {
  return {
    AGENT_BROWSER_NAMESPACE: `verify_${projectHash.slice(0, 12)}`,
    AGENT_BROWSER_SESSION: mode,
    AGENT_BROWSER_CONTENT_BOUNDARIES: "1",
    AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0",
    AGENT_BROWSER_MAX_OUTPUT: "50000",
    SHIPBASH_BROWSER_ID: mode,
  };
}

/**
 * The leg's outcome in this log text, or null when the leg has not finished.
 * Read by parsing each line rather than matching text inside it: the leg's
 * events are whole JSON documents, and a pattern over their text would turn
 * on which key the emitter happens to write first.
 * @param {string} logText
 * @returns {{ verified: boolean, label: string | null, reason: string | null } | null}
 */
export function signInVerifyOutcomeFrom(logText) {
  for (const line of logText.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === "sign_in_verified") {
      return { verified: true, label: typeof event.label === "string" ? event.label : null, reason: null };
    }
    if (event.type === "sign_in_verify_failed") {
      return { verified: false, label: null, reason: typeof event.reason === "string" ? event.reason : "unknown" };
    }
  }
  return null;
}
