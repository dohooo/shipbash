// Settings password check: the agent reads credentials from the broker and operates its own browser.
import { mkdir, writeFile } from "node:fs/promises";

import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

import { captureBrowserState, cdpBaseUrl } from "../browser-state-capture.mjs";
import { sealBrowserState, sealedStateVersion } from "../browser-state-seal.mjs";
import { validateBrowserConnection } from "../browser-connection.mjs";
import { consumeTaskApiConfig } from "../task-api.mjs";

import {
  CONTROL_ROOT,
  SIGN_IN_LOGIN_STATE_PATH,
  WORK_DIRECTORY,
} from "./environment.mjs";
import {
  agentBrowser,
  cleanBrowserEnvironment,
} from "./browser.mjs";
import { registerSecret, safeError } from "./redaction.mjs";
import { runSignInAgent } from "./sign-in-agent.mjs";
import { consumeSignInConfig } from "./sign-in-one-shot-config.mjs";
import { emit, setSuiteRunId } from "./state.mjs";

/**
 * The leg's config, read once off the one-shot mount and then taken away by
 * the host. It names the pages and the browser key; the credential itself is
 * never on it — the agent reads that from the broker when it signs in.
 *
 * @returns {Promise<{
 *   browserCdpUrl: string, modelContract: unknown,
 *   productionUrl: string, signInPageUrl: string, encryptionKey: string,
 * }>}
 */
function consumeLoginConfig() {
  return consumeSignInConfig((parsed) => {
    if (
      !isRecord(parsed) || typeof parsed.productionUrl !== "string"
      || typeof parsed.encryptionKey !== "string" || typeof parsed.browserCdpUrl !== "string"
    ) {
      throw new Error("The sign-in login config is missing its product URL, key or browser.");
    }
    validateBrowserConnection(parsed.browserCdpUrl);
    return {
      browserCdpUrl: parsed.browserCdpUrl,
      modelContract: parsed.modelContract,
      productionUrl: parsed.productionUrl,
      signInPageUrl: typeof parsed.signInPageUrl === "string" && parsed.signInPageUrl.length > 0
        ? parsed.signInPageUrl
        : parsed.productionUrl,
      encryptionKey: parsed.encryptionKey,
    };
  });
}

/**
 * Seals what the browser now holds onto the control mount and answers with
 * the name the host gives those bytes. The same sealing the takeover capture
 * uses, so promotion copies rather than re-seals.
 */
async function saveSession(baseUrl, encryptionKey) {
  const { state } = await captureBrowserState(baseUrl, { label: "Sign-in browser" });
  const sealed = sealBrowserState(state, encryptionKey);
  await writeFile(SIGN_IN_LOGIN_STATE_PATH, sealed, { mode: 0o600 });
  return { stateVersion: sealedStateVersion(sealed), cookies: state.cookies.length };
}

export async function runSignInLogin() {
  setSuiteRunId(process.env.SHIPBASH_BROWSER_ID ?? "sign-in-login");
  await Promise.all([mkdir(CONTROL_ROOT, { recursive: true }), mkdir(WORK_DIRECTORY, { recursive: true })]);
  const config = await consumeLoginConfig();
  await consumeTaskApiConfig({ root: CONTROL_ROOT, registerSecret });
  const env = cleanBrowserEnvironment({
    AGENT_BROWSER_NAMESPACE: process.env.AGENT_BROWSER_NAMESPACE ?? "sign-in-login",
    AGENT_BROWSER_SESSION: process.env.AGENT_BROWSER_SESSION ?? "sign-in-login",
    // The key rides the one-shot config, never the container's environment:
    // a key on `docker run` argv is on the host's process list.
    AGENT_BROWSER_ENCRYPTION_KEY: config.encryptionKey,
    AGENT_BROWSER_CDP: config.browserCdpUrl,
  });
  try {
    // Join the project browser without navigating, replacing it or starting another stream.
    const cdpReply = await agentBrowser(["get", "cdp-url"], env);
    const baseUrl = cdpBaseUrl(cdpReply);
    const verdict = await runSignInAgent(config, env);
    if (!verdict.verified) {
      emit("infrastructure", "sign_in_verify_failed", { reason: verdict.reason, tier: verdict.tier, signals: verdict.signals });
      return;
    }
    const saved = await saveSession(baseUrl, config.encryptionKey);
    emit("infrastructure", "sign_in_verified", {
      label: verdict.label, tier: verdict.tier, signals: verdict.signals, ...saved,
    });
  } catch (error) {
    // A leg that could not run is a leg that proved nothing; the sign-in is
    // not ticked on a fault, and the host is told which fault it was.
    emit("infrastructure", "sign_in_verify_failed", { reason: "unknown", message: safeError(error) });
  }
}
