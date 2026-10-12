// Capturing the takeover browser's session when the person says they are
// done. The host cannot reach into the container, so it leaves a request id
// on the read-only control mount; the idle lane notices it on its next tick,
// reads the whole browser over CDP — every cookie Chromium holds, the
// identity provider's own among them, because a Clerk or Auth0 root session
// lives on the provider's domain and filtering by the product's would throw
// the sign-in away — seals it under the Project's key, and answers with the
// same id.
//
// It does not judge. Whether this session actually gets into the product is
// the verification leg's call, made by opening the product with it; a
// capture that refused here would decide the tick on the person's word,
// which is exactly what the leg exists to avoid. It does name the GitHub
// account its HttpOnly github.com cookies hold, so a GitHub sign-in is saved
// knowing whose it is.
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";

import { captureBrowserState, cdpBaseUrl } from "../browser-state-capture.mjs";
import { sealBrowserState, sealedStateVersion } from "../browser-state-seal.mjs";
import { githubAccountLogin } from "../github-account-identity.mjs";

import {
  SIGN_IN_CAPTURE_ANSWER_PATH,
  SIGN_IN_CAPTURE_REQUEST_PATH,
  SIGN_IN_CAPTURE_STATE_PATH,
} from "./environment.mjs";
import { agentBrowser } from "./browser.mjs";
import { safeError } from "./redaction.mjs";
import { emit } from "./state.mjs";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u;

/** The pending request id on the control mount, or null when there is none. */
async function pendingRequestId() {
  if (!existsSync(SIGN_IN_CAPTURE_REQUEST_PATH)) return null;
  const value = (await readFile(SIGN_IN_CAPTURE_REQUEST_PATH, "utf8").catch(() => "")).trim();
  return REQUEST_ID_PATTERN.test(value) ? value : null;
}

/**
 * Seals the browser's whole state under the Project's key and returns the
 * version the host names those bytes by, with the GitHub account those
 * cookies are signed in to when they are.
 *
 * @param {Record<string, string | undefined>} env The browser environment, carrying the key.
 * @returns {Promise<{ version: string, cookies: number, origins: number, githubAccountLogin: string | null }>}
 */
async function sealBrowserSession(env) {
  const encryptionKey = env.AGENT_BROWSER_ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error("The Project sign-in encryption key is unavailable.");
  const cdpReply = await agentBrowser(["get", "cdp-url"], env, { cancelable: false, timeoutMs: 15_000 });
  const { state } = await captureBrowserState(cdpBaseUrl(cdpReply), { label: "Sign-in browser" });
  const sealed = sealBrowserState(state, encryptionKey);
  await writeFile(SIGN_IN_CAPTURE_STATE_PATH, sealed, { mode: 0o600 });
  return {
    version: sealedStateVersion(sealed),
    cookies: state.cookies.length,
    origins: state.origins.length,
    githubAccountLogin: githubAccountLogin(state.cookies),
  };
}

/**
 * The capture watcher the idle lane ticks. It answers each request id once —
 * a host that asks twice gets two captures, a host that asks once and reads
 * slowly gets one — and never throws: a capture fault is an answer saying so,
 * not the end of the lane the person is still looking at.
 *
 * @param {{ env: Record<string, string | undefined> }} input
 * @returns {{ poll: () => Promise<void> }}
 */
export function createSignInCaptureWatcher({ env }) {
  let answered = null;
  return {
    async poll() {
      let requestId = null;
      try {
        requestId = await pendingRequestId();
        if (requestId === null || requestId === answered) return;
        const sealed = await sealBrowserSession(env);
        answered = requestId;
        await writeFile(
          SIGN_IN_CAPTURE_ANSWER_PATH,
          `${JSON.stringify({ requestId, ok: true, ...sealed })}\n`,
          { mode: 0o600 },
        );
        emit("infrastructure", "sign_in_session_captured", { stateVersion: sealed.version, cookies: sealed.cookies, origins: sealed.origins });
      } catch (error) {
        if (requestId === null) return;
        answered = requestId;
        const message = safeError(error);
        await rm(SIGN_IN_CAPTURE_STATE_PATH, { force: true }).catch(() => {});
        await writeFile(
          SIGN_IN_CAPTURE_ANSWER_PATH,
          `${JSON.stringify({ requestId, ok: false, message })}\n`,
          { mode: 0o600 },
        ).catch(() => {});
        emit("infrastructure", "sign_in_session_capture_failed", { message });
      }
    },
  };
}
