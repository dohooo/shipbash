// The browser-idle lane: a parked browser, launched by the harness and joined
// by an agent-browser session other containers drive over docker exec (the
// host reads the browser's address from LANE_BROWSER_CDP_URL_PATH and names
// it in each call), streamed through its own screencast sidecar until the run
// is canceled.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { LANE_BROWSER_CDP_URL_PATH } from "@shipbash/contracts/runtime/browser-lane.mjs";

import { indexedDbRestoreSummary, restoreIndexedDbFromStateFile } from "../browser-state-restore.mjs";
import { createControlLeaseReader } from "../control-lease-reader.mjs";
import { prepareDesktopBrowser } from "../desktop-browser.mjs";
import { launchHarnessBrowser } from "../harness-browser.mjs";
import { startScreencastSidecar } from "../screencast-sidecar.mjs";
import { WEBAUTHN_UNAVAILABLE_SCRIPT } from "../webauthn-unavailable.mjs";
import { STREAM_GATEWAY_PORT } from "../stream-lane.mjs";

import { CONTROL_ROOT, SIGN_IN_CONTROL_LEASE_PATH, SIGN_IN_HEADLESS, WORK_DIRECTORY } from "./environment.mjs";
import { createIdleTracker } from "./browser-idle-lifecycle.mjs";
import { createSignInCaptureWatcher } from "./sign-in-capture.mjs";
import { checkCancellation, emit, setSuiteRunId } from "./state.mjs";
import {
  agentBrowser,
  announceStreamPort,
  cleanBrowserEnvironment,
  closeStreamGateway,
  viewerCount,
} from "./browser.mjs";
import { existingAuthStatePath } from "./auth-handshake.mjs";

export async function runBrowserIdle() {
  setSuiteRunId(process.env.SHIPBASH_BROWSER_ID ?? "browser-idle");
  await Promise.all([
    mkdir(CONTROL_ROOT, { recursive: true }),
    mkdir(join(CONTROL_ROOT, "auth"), { recursive: true }),
    mkdir(WORK_DIRECTORY, { recursive: true }),
  ]);
  const namespace = process.env.AGENT_BROWSER_NAMESPACE ?? "browser-idle";
  const session = process.env.AGENT_BROWSER_SESSION ?? "browser-idle";
  const startUrl = process.env.SHIPBASH_BROWSER_URL ?? "about:blank";
  const env = cleanBrowserEnvironment({
    AGENT_BROWSER_NAMESPACE: namespace,
    AGENT_BROWSER_SESSION: session,
  });
  let laneBrowser = null;
  let idleSidecar = null;
  try {
    // The host drives this browser by docker exec, naming it as this lane does.
    laneBrowser = await launchHarnessBrowser({ env, desktop: !SIGN_IN_HEADLESS, announcePath: LANE_BROWSER_CDP_URL_PATH });
    if (!SIGN_IN_HEADLESS) await prepareDesktopBrowser(agentBrowser, env);
    // The lane starts on an ephemeral profile; the user's existing sign-in
    // arrives from the canonical state file, never from profile bytes.
    const preloadStatePath = existingAuthStatePath();
    if (preloadStatePath) {
      await agentBrowser(["state", "load", preloadStatePath], env, { timeoutMs: 30_000 });
      // state load ignores IndexedDB; it goes back over CDP, and never blocks the lane.
      const restored = await restoreIndexedDbFromStateFile({
        agentBrowser, env, statePath: preloadStatePath, options: { timeoutMs: 30_000 },
      });
      if (restored) emit("browser", "sign_in_indexeddb_restored", { mode: "browser_idle", ...indexedDbRestoreSummary(restored) });
    }
    await agentBrowser(["open", startUrl], env);
    idleSidecar = await startScreencastSidecar({
      cdpUrl: laneBrowser.cdpUrl,
      // A person drives this browser to sign in; a headless Chromium with no
      // authenticator behind it must not offer a passkey it can only hang on.
      initScripts: [WEBAUTHN_UNAVAILABLE_SCRIPT],
      // A human sign-in drives this lane from the same canvas the Activity
      // takeover uses, so the sidecar needs the lease to gate viewer input
      // on. Without the host's control mount the file never exists and the
      // reader answers null forever: the stream stays read-only pixels.
      readControlToken: createControlLeaseReader(SIGN_IN_CONTROL_LEASE_PATH),
    });
    await announceStreamPort(idleSidecar.port);
    emit("browser", "browser_stream_ready", {
      mode: "browser_idle",
      containerPort: STREAM_GATEWAY_PORT,
      namespace,
      session,
    });
    emit("infrastructure", "browser_idle_ready", {
      namespace,
      session,
      message:
        "The browser and its agent-browser daemon are ready; docker exec commands join them by this namespace and session.",
    });
    // Exit when genuinely unused so the host stops paying for a parked
    // Chromium: no stream viewer for the idle window.
    const tracker = createIdleTracker({ now: () => performance.now() });
    // A takeover mount also carries the host's "I'm done": the same tick that
    // measures idleness answers it, so the session is sealed from the browser
    // the person actually drove.
    const capture = createSignInCaptureWatcher({ env });
    while (true) {
      checkCancellation();
      await capture.poll();
      tracker.observe({ viewers: viewerCount() });
      if (tracker.shouldExit()) {
        emit("infrastructure", "browser_idle_exit", { viewers: viewerCount(), mode: "browser_idle" });
        break;
      }
      await delay(1_000);
    }
  } finally {
    await idleSidecar?.close().catch(() => {});
    await closeStreamGateway();
    await laneBrowser?.close();
  }
}
