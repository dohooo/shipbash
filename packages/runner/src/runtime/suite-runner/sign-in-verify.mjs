// All sign-in checks use the project's existing browser and stream.
// A just-completed sign-in keeps its live session; checking a saved sign-in
// replaces authentication storage first so another account cannot prove it.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

import { captureFirstFrame, settleSignIn } from "../activity-runner/first-frame.mjs";
import { indexedDbRestoreSummary, restoreStateFile } from "../browser-state-restore.mjs";
import { captureBrowserState, cdpBaseUrl, cdpEndpoints } from "../browser-state-capture.mjs";
import { readBrowserStateFile } from "../browser-state-seal.mjs";
import { validateBrowserConnection } from "../browser-connection.mjs";
import { openCdpChannel } from "../cdp-channel.mjs";
import { needsOwner, pageJudge } from "../page-kind.mjs";

import { CONTROL_ROOT, WORK_DIRECTORY } from "./environment.mjs";
import { firstFrameClient } from "./sign-in-leg-page.mjs";
import { consumeSignInConfig } from "./sign-in-one-shot-config.mjs";
import {
  agentBrowser,
  cleanBrowserEnvironment,
} from "./browser.mjs";
import { safeError } from "./redaction.mjs";
import { signInVerdict } from "./sign-in-verdict.mjs";
import { emit, setSuiteRunId } from "./state.mjs";

/** A wall a live session should have redirected past long before this. */
const SETTLE_MS = 8_000;

/**
 * Reads the session to verify, then waits for the host to take the file
 * away. Same handshake as Trusted access: the secret exists on the mount for
 * exactly as long as it takes to read, and a host that will not release it
 * is a fault, not a leg that carries on with a file still lying there.
 *
 * @returns {Promise<{ productionUrl: string, encryptionKey: string, state: Buffer }>}
 */
function consumeVerifyConfig() {
  return consumeSignInConfig((parsed) => {
    if (
      !isRecord(parsed) || typeof parsed.productionUrl !== "string"
      || typeof parsed.encryptionKey !== "string" || typeof parsed.state !== "string"
      || typeof parsed.browserCdpUrl !== "string"
    ) {
      throw new Error("The sign-in verification config is missing its product URL, key or session.");
    }
    return {
      productionUrl: parsed.productionUrl,
      browserCdpUrl: validateBrowserConnection(parsed.browserCdpUrl),
      useCurrentSession: parsed.useCurrentSession === true,
      encryptionKey: parsed.encryptionKey,
      state: Buffer.from(parsed.state, "base64"),
    };
  });
}

/** Clear the previous account before loading a different saved session. */
async function clearPreviousSignIn(env, config, statePath) {
  const saved = await readBrowserStateFile(statePath, config.encryptionKey);
  const endpoint = await agentBrowser(["get", "cdp-url"], env);
  const { state: current } = await captureBrowserState(cdpBaseUrl(endpoint), { label: "Sign-in browser" });
  const origins = new Set([...current.origins, ...saved.origins].map(entry => entry.origin));
  const { targets } = await cdpEndpoints(cdpBaseUrl(endpoint));
  const pages = Array.isArray(targets) ? targets.filter(page => isRecord(page) && page.type === "page" && typeof page.webSocketDebuggerUrl === "string") : [];
  if (pages.length === 0) throw new Error("The sign-in browser has no page to restore.");
  for (const page of pages) {
    const channel = await openCdpChannel(page.webSocketDebuggerUrl);
    try {
      await channel.command("Storage.clearCookies");
      for (const origin of origins) await channel.command("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
      await channel.command("Runtime.evaluate", { expression: "if (location.origin !== 'null') sessionStorage.clear()" });
    } finally { channel.close(); }
  }
}

/**
 * Loads the requested saved session into the existing browser: the sealed bytes
 * onto the container's own tmpfs, restored over CDP (browser-state-restore.mjs),
 * then the product. The file goes as soon as the browser holds it.
 */
export async function openProductWithSession(env, config) {
  if (config.useCurrentSession) {
    const reply = await agentBrowser(["get", "url"], env);
    const currentUrl = reply.json?.data?.url;
    const target = new URL(config.productionUrl);
    if (typeof currentUrl !== "string" || new URL(currentUrl).origin !== target.origin
      || (target.pathname !== "/" && new URL(currentUrl).pathname !== target.pathname)) {
      await agentBrowser(["open", config.productionUrl], env);
    }
    return;
  }
  const statePath = join(WORK_DIRECTORY, "sign-in-verify.json.enc");
  await writeFile(statePath, config.state, { mode: 0o600 });
  try {
    await clearPreviousSignIn(env, config, statePath);
    const restored = await restoreStateFile({ env, statePath, timeoutMs: 30_000 });
    if (restored) emit("browser", "sign_in_indexeddb_restored", { mode: "sign_in_verify", ...indexedDbRestoreSummary(restored) });
  } finally {
    await rm(statePath, { force: true }).catch(() => {});
  }
  await agentBrowser(["open", config.productionUrl], env);
}

/**
 * Reads the frame the product settled on. A session that works may still
 * flash its sign-in screen for one redirect, so a first frame Jev
 * says needs the owner is given that redirect before it is judged.
 */
async function settledFrame(env, judge) {
  const browser = firstFrameClient(agentBrowser);
  const frame = await captureFirstFrame({ agentBrowser: browser, env });
  if (!frame || !needsOwner(await judge(frame))) return frame;
  const settle = await settleSignIn({ agentBrowser: browser, env, judge, timeoutMs: SETTLE_MS });
  emit("browser", "sign_in_verify_settled", { outcome: settle.outcome, waitedMs: settle.waitedMs, looks: settle.looks });
  return settle.frame ?? frame;
}

export async function runSignInVerify() {
  setSuiteRunId(process.env.SHIPBASH_BROWSER_ID ?? "sign-in-verify");
  await Promise.all([mkdir(CONTROL_ROOT, { recursive: true }), mkdir(WORK_DIRECTORY, { recursive: true })]);
  const config = await consumeVerifyConfig();
  const env = cleanBrowserEnvironment({
    AGENT_BROWSER_NAMESPACE: process.env.AGENT_BROWSER_NAMESPACE ?? "sign-in-verify",
    AGENT_BROWSER_SESSION: process.env.AGENT_BROWSER_SESSION ?? "sign-in-verify",
    // The key rides the one-shot config, never the container's environment:
    // a key on `docker run` argv is on the host's process list.
    AGENT_BROWSER_ENCRYPTION_KEY: config.encryptionKey,
    AGENT_BROWSER_CDP: config.browserCdpUrl,
  });
  try {
    await openProductWithSession(env, config);
    const judge = pageJudge(env);
    const verdict = await signInVerdict(await settledFrame(env, judge), config.productionUrl, judge);
    if (verdict.verified) {
      emit("infrastructure", "sign_in_verified", { label: verdict.label, kind: verdict.kind, judged: verdict.judged, humanCheck: verdict.humanCheck });
    } else {
      emit("infrastructure", "sign_in_verify_failed", { reason: verdict.reason, kind: verdict.kind, judged: verdict.judged, humanCheck: verdict.humanCheck });
    }
  } catch (error) {
    // A leg that could not run is a leg that proved nothing; the sign-in is
    // not ticked on a fault, and the host is told which fault it was.
    emit("infrastructure", "sign_in_verify_failed", { reason: "unknown", message: safeError(error) });
  }
}
