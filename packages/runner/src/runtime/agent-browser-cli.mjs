import { UNTIMED } from "@shipbash/contracts/runtime/phase-timing.mjs";

import { prepareDesktopBrowser } from "./desktop-browser.mjs";
/**
 * The agent-browser CLI wrapper both container runners drive the harness's
 * browser through (harness-browser.mjs). Every call joins that browser
 * (AGENT_BROWSER_CDP) and a call without it is refused: agent-browser would
 * launch a browser of its own. Activity unwraps the JSON reply while the
 * suite runner keeps the full process result.
 */
import { restoreStateFile } from "./browser-state-restore.mjs";
import {
  CLOUDFLARE_CHALLENGE_SCRIPT,
  cloudflareChallengeFromBrowserResult,
  startTrustedAccessNavigation,
} from "./trusted-access.mjs";

/**
 * What a state file adds to an open: the sign-in restored over CDP
 * (browser-state-restore.mjs), announced, before the product opens. A state
 * that cannot be read or set throws; what of its storage did not go back is
 * handed to the runner's observer.
 */
async function loadStateIntoBrowser({ onStateLoaded, onIndexedDbRestored }, statePath, env) {
  const restored = await restoreStateFile({ env, statePath });
  onStateLoaded?.();
  if (restored && onIndexedDbRestored) onIndexedDbRestored(restored);
}

export function parseLastJson(stdout) {
  const lines = String(stdout)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Some commands may include non-JSON progress lines before their JSON result.
    }
  }
  return null;
}

/**
 * The error field of a parsed agent-browser reply, redacted; null when the
 * reply carried none. A structured cause rides along as its JSON text.
 */
function redactedResponseError(parsed, redactResponseError) {
  const responseError = parsed && typeof parsed === "object" ? parsed.error : null;
  if (responseError === null || responseError === undefined) return null;
  return redactResponseError(
    typeof responseError === "string" ? responseError : JSON.stringify(responseError),
  );
}

export function createAgentBrowserCli({
  runProcess,
  CancellationError,
  stderrTailBytes,
  redactResponseError,
  commandFailureMessage,
  desktop = false,
  unwrapJson = false,
  openFlow = {},
}) {

  /** Redacted, bounded post-mortem for a failed agent-browser invocation. */
  function agentBrowserDiagnostics(args, result) {
    // agent-browser answers on stdout even when it fails; its error field is
    // usually the whole story.
    const parsed = parseLastJson(result.stdout);
    return {
      command: `agent-browser ${args.join(" ")}`,
      exitCode: result.code ?? null,
      signal: result.signal ?? null,
      timedOut: result.timedOut === true,
      durationMs: result.durationMs ?? null,
      stderrTail: String(result.stderrTail ?? "").slice(-stderrTailBytes),
      responseError: redactedResponseError(parsed, redactResponseError),
    };
  }

  async function agentBrowser(args, env, options = {}) {
    if (!env?.AGENT_BROWSER_CDP) {
      throw new Error("agent-browser was called without the harness's browser (AGENT_BROWSER_CDP); it must never launch one of its own.");
    }
    const result = await runProcess("agent-browser", [...args, "--json"], {
      env,
      cancelable: options.cancelable ?? true,
      timeoutMs: options.timeoutMs ?? 45_000,
    });
    if (result.canceled) {
      throw new CancellationError();
    }
    if (result.timedOut || result.code !== 0) {
      // The sentence stays the one a reader can act on; the machine-readable
      // cause rides along so a caller can report WHY.
      const failure = new Error(commandFailureMessage(args, result));
      failure.diagnostics = agentBrowserDiagnostics(args, result);
      throw failure;
    }
    return unwrapJson
      ? parseLastJson(result.stdout)
      : { ...result, json: parseLastJson(result.stdout) };
  }

  /**
   * Brings the harness's browser, launched on about:blank, to the product:
   * the desktop viewport first, the saved sign-in next, then the product
   * itself, or the trusted-access navigation that opens it. A caller timing
   * its setup passes its `timing`, and each of these steps is a phase of it;
   * the desktop probe is the walk's first agent-browser call, so it also
   * starts the walk's agent-browser daemon.
   */
  async function openProductionBrowser(productionUrl, statePath, env, trustedAccess, { timing = UNTIMED, ...options } = {}) {
    if (desktop) await timing.time("desktop_probe", () => prepareDesktopBrowser(agentBrowser, env, options));
    if (statePath) await timing.time("sign_in_load", () => loadStateIntoBrowser(openFlow, statePath, env));
    if (!trustedAccess) {
      await timing.time("page_open", () => agentBrowser(["open", productionUrl], env, options));
      return null;
    }
    const cdpResult = await timing.time("cdp_url", () => agentBrowser(["get", "cdp-url"], env, options));
    return startTrustedAccessNavigation(
      unwrapJson ? cdpResult : cdpResult.json,
      productionUrl,
      trustedAccess,
    );
  }

  async function inspectCloudflareChallenge(env) {
    const result = await agentBrowser(["eval", CLOUDFLARE_CHALLENGE_SCRIPT], env);
    return cloudflareChallengeFromBrowserResult(unwrapJson ? result : result.json);
  }

  return {
    agentBrowser,
    agentBrowserDiagnostics,
    openProductionBrowser,
    inspectCloudflareChallenge,
  };
}
