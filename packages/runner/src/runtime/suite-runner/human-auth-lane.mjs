// The human-auth viewer lane: a headed Chromium on Xvfb behind noVNC where a
// person signs in while the Agent browser stays stopped. Supervises the
// viewer services with bounded restarts and captures the signed-in state over
// CDP on the way down.
import { randomBytes } from "node:crypto";
import { appendFile, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { httpUrl } from "@shipbash/contracts/runtime/contract-values.mjs";
import { LANE_WEBMCP_ENV } from "@shipbash/contracts/runtime/browser-lane.mjs";
import {
  BROWSER_RECORDING_HEIGHT,
  BROWSER_RECORDING_WIDTH,
} from "../browser-recording.mjs";
import { childIsRunning } from "../child-process.mjs";
import { disableChromiumPasswordManager } from "../chromium-preferences.mjs";
import { launchHarnessBrowser } from "../harness-browser.mjs";
import { consumeTrustedAccessConfig } from "../trusted-access.mjs";

import {
  HOME_DIRECTORY,
  HUMAN_AUTH_DISPLAY,
  HUMAN_AUTH_PASSWORD_PATH,
  HUMAN_AUTH_PROFILE_PATH,
  HUMAN_AUTH_VNC_PORT,
  HUMAN_AUTH_WEB_PORT,
  HUMAN_AUTH_XDG_RUNTIME_PATH,
  WORK_DIRECTORY,
} from "./environment.mjs";
import { registerTrustedAccess, safeError } from "./redaction.mjs";
import {
  CancellationError,
  emit,
  isCancellationRequested,
  setHumanAuthServices,
  setSuiteRunId,
} from "./state.mjs";
import {
  assertManagedServiceRunning,
  managedServiceError,
  startManagedService,
  stopManagedServices,
  waitForPath,
  waitForTcpPort,
} from "./processes.mjs";
import { useViewerBrowser } from "./human-auth-cdp.mjs";
import { startAnonymousBaseline } from "./human-auth-baseline.mjs";
import {
  captureConnectedHumanAuthCandidate,
  installKeyboardDiagnostics,
  preloadRefusedCandidate,
  preloadSavedState,
  readKeyboardDiagnostics,
  startHumanTrustedAccessNavigation,
} from "./human-auth-capture.mjs";

/**
 * The person's browser: launched as every browser is (harness-browser.mjs),
 * on the viewer's display, in its kiosk (the page and nothing of the
 * browser's own around it: the console draws an address bar and a tab strip
 * around this stream and keeps them through a takeover,
 * activity-browser-stream.tsx), with the viewer's own profile, which outlives
 * a relaunch. No agent joins it, so its launch alone carries the lanes'
 * WebMCP setting (off, like every lane's browser). Every CDP read of the
 * viewer goes to it from here on.
 */
async function launchViewerBrowser(env, startUrl) {
  const browser = await launchHarnessBrowser({
    env: { ...env, ...LANE_WEBMCP_ENV },
    desktop: true,
    userDataDir: HUMAN_AUTH_PROFILE_PATH,
    startUrl,
  });
  useViewerBrowser(browser.cdpUrl);
  return browser;
}

export function humanAuthPassword(env = process.env) {
  const configured = env.SHIPBASH_HUMAN_AUTH_PASSWORD;
  const password = configured === undefined
    ? randomBytes(24).toString("base64url")
    : configured;
  if (password.trim().length === 0) {
    throw new Error("SHIPBASH_HUMAN_AUTH_PASSWORD must be a non-empty string.");
  }
  if (/[\0\r\n]/.test(password)) {
    throw new Error("SHIPBASH_HUMAN_AUTH_PASSWORD contains unsupported characters.");
  }
  if (Buffer.byteLength(password, "utf8") > 1_024) {
    throw new Error("SHIPBASH_HUMAN_AUTH_PASSWORD must be at most 1024 bytes.");
  }
  return password;
}

const HUMAN_AUTH_SERVICE_RESTART_LIMIT = 3;

// Viewer service diagnostics must survive the process, so they are appended to
// a file in the work directory instead of only reaching process stderr. This is
// the primary forensic record when a hosted viewer dies in production.
// Reads the takeover's keyboard lock diagnostic and both emits it and — since
// this container's stdout is not read after startup — leaves the summary in
// the bind-mounted auth directory for the host to inspect after teardown.
async function reportKeyboardLockDiagnostic() {
  const diagnostic = await readKeyboardDiagnostics();
  emit("browser", "human_auth_keyboard_diagnostic", {
    mode: "human_auth",
    ...diagnostic,
    message: `Takeover keyboard lock state — keydowns:${String(diagnostic.events)} capsLockSeen:${String(diagnostic.capsSeen)} numLockSeen:${String(diagnostic.numSeen)}`,
  });
}

// The candidate capture on the SIGTERM path, lifted out of runHumanAuth's
// teardown so the walk's viewer loop stays readable. Only fires while a person
// was actually connected (cancellation requested with Chromium still alive).
async function captureSignedInStateOnTeardown(viewer, productionUrl) {
  if (!isCancellationRequested() || !viewer.browser?.running()) return;
  await reportKeyboardLockDiagnostic();
  try {
    await captureConnectedHumanAuthCandidate(productionUrl);
    emit("browser", "human_auth_state_captured", {
      mode: "human_auth",
      message: "The authenticated browser state was captured before Chromium closed.",
    });
  } catch (error) {
    emit("infrastructure", "human_auth_state_capture_failed", {
      mode: "human_auth",
      message: safeError(error),
    });
  }
}

async function appendHumanAuthServiceLog(message) {
  try {
    await appendFile(
      join(WORK_DIRECTORY, "human-auth-services.log"),
      `${new Date().toISOString()} ${message}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Diagnostics must never break the handoff itself.
  }
}

/**
 * The display every other viewer service attaches to. Both services are
 * pushed onto `services` as they start, so a teardown that runs mid-startup
 * still sees exactly what is alive.
 */
async function startViewerDisplay(services, env) {
  const xvfb = startManagedService(
    "Xvfb",
    "Xvfb",
    [HUMAN_AUTH_DISPLAY, "-screen", "0",
      // The virtual screen must fit the browser viewport at native scale;
      // a smaller screen would clamp the window and cost the agent the
      // extra page it is meant to see.
      `${String(BROWSER_RECORDING_WIDTH)}x${String(BROWSER_RECORDING_HEIGHT)}x24`,
      "-nolisten", "tcp", "-noreset"],
    env,
  );
  services.push(xvfb);
  await waitForPath("/tmp/.X11-unix/X99", xvfb, 15_000);

  const openbox = startManagedService("Openbox", "openbox", ["--sm-disable"], env);
  services.push(openbox);
  await assertManagedServiceRunning(openbox);
}

/**
 * The viewer proper, on top of a running display and an already-written
 * password file: x11vnc, websockify, then the person's browser, each waited
 * for before the next starts. Returns the argv the supervisor needs to
 * restart the services.
 */
async function startViewerServices(services, env, viewer, startUrl) {
  const x11vncArgs = [
    "-display",
    HUMAN_AUTH_DISPLAY,
    "-localhost",
    "-rfbport",
    String(HUMAN_AUTH_VNC_PORT),
    "-forever",
    "-shared",
    "-passwdfile",
    `rm:${HUMAN_AUTH_PASSWORD_PATH}`,
    "-quiet",
  ];
  const x11vnc = startManagedService("x11vnc", "x11vnc", x11vncArgs, env);
  services.push(x11vnc);
  await waitForTcpPort(HUMAN_AUTH_VNC_PORT, x11vnc, 15_000);

  const websockifyArgs = [
    "--web=/usr/share/novnc",
    `0.0.0.0:${HUMAN_AUTH_WEB_PORT}`,
    `127.0.0.1:${HUMAN_AUTH_VNC_PORT}`,
  ];
  const websockify = startManagedService("websockify", "websockify", websockifyArgs, env);
  services.push(websockify);
  await waitForTcpPort(HUMAN_AUTH_WEB_PORT, websockify, 15_000);

  // Chromium's first launch in a fresh Sandbox can take far longer than a warm
  // one's to listen; the launch waits and retries as agent-browser's did.
  viewer.browser = await launchViewerBrowser(env, startUrl);
  return { x11vncArgs, websockifyArgs };
}

/** The person's browser once more, a bounded number of times, on the same profile. */
async function relaunchViewerBrowser(viewer, env, startUrl, restartCounts) {
  const used = restartCounts.get("Chromium") ?? 0;
  if (used >= HUMAN_AUTH_SERVICE_RESTART_LIMIT) {
    await appendHumanAuthServiceLog("Chromium exited; fatal after restart limit");
    throw new Error("The sign-in browser exited and could not be restarted.");
  }
  restartCounts.set("Chromium", used + 1);
  await appendHumanAuthServiceLog(`Chromium exited; restarting (${String(used + 1)}/${String(HUMAN_AUTH_SERVICE_RESTART_LIMIT)})`);
  await viewer.browser.close();
  return launchViewerBrowser(env, startUrl);
}

/**
 * Watches the running viewer until cancellation. Xvfb is the foundation every
 * other service is attached to, so its exit stays fatal. The rest are
 * restarted in place a bounded number of times so one crashed service does
 * not tear down an otherwise healthy viewer.
 */
async function superviseViewerServices({ services, env, x11vncArgs, websockifyArgs, viewer, startUrl, restartPassword }) {
  const restartableSpecs = new Map([
    ["Openbox", { command: "openbox", args: ["--sm-disable"] }],
    ["x11vnc", {
      command: "x11vnc",
      args: x11vncArgs,
      prepare: () => writeFile(HUMAN_AUTH_PASSWORD_PATH, `${restartPassword}\n`, {
        encoding: "utf8",
        mode: 0o600,
      }),
    }],
    ["websockify", { command: "websockify", args: websockifyArgs }],
  ]);
  const restartCounts = new Map();
  while (!isCancellationRequested()) {
    if (!viewer.browser.running()) {
      viewer.browser = await relaunchViewerBrowser(viewer, env, startUrl, restartCounts);
      continue;
    }
    const exited = services.find((service) => !childIsRunning(service.child));
    if (exited) {
      const detail = `code ${exited.child.exitCode ?? "none"}, signal ${exited.child.signalCode ?? "none"}`;
      const spec = restartableSpecs.get(exited.name);
      const used = restartCounts.get(exited.name) ?? 0;
      if (!spec || used >= HUMAN_AUTH_SERVICE_RESTART_LIMIT) {
        await appendHumanAuthServiceLog(
          `${exited.name} exited (${detail}); fatal${spec ? " after restart limit" : ""}`,
        );
        throw managedServiceError(exited);
      }
      restartCounts.set(exited.name, used + 1);
      await appendHumanAuthServiceLog(
        `${exited.name} exited (${detail}); restarting (${String(used + 1)}/${String(HUMAN_AUTH_SERVICE_RESTART_LIMIT)})`,
      );
      services.splice(services.indexOf(exited), 1);
      await spec.prepare?.();
      services.push(startManagedService(exited.name, spec.command, spec.args, env));
      continue;
    }
    await delay(250);
  }
}

export async function runHumanAuth() {
  setSuiteRunId(process.env.SHIPBASH_BROWSER_ID ?? "human-auth");
  const productionUrl = httpUrl(
    process.env.SHIPBASH_HUMAN_AUTH_URL,
    "SHIPBASH_HUMAN_AUTH_URL",
  );
  const trustedAccess = await consumeTrustedAccessConfig(productionUrl);
  registerTrustedAccess(trustedAccess);
  // With trusted access the viewer starts blank: the navigation that carries its header opens the product.
  const startUrl = trustedAccess ? "about:blank" : productionUrl;
  let vncPassword = humanAuthPassword();
  // Retained until teardown so a crashed x11vnc can be restarted with a fresh
  // password file (x11vnc consumes and deletes the original via `rm:`).
  let restartPassword = vncPassword;
  delete process.env.SHIPBASH_HUMAN_AUTH_PASSWORD;
  const services = [];
  // The person's browser, which a restart replaces: the teardown ends whichever is current.
  const viewer = { browser: null };
  let trustedAccessNavigation = null;
  setHumanAuthServices(services);
  try {
    await Promise.all([
      mkdir(HUMAN_AUTH_PROFILE_PATH, { recursive: true }),
      mkdir(HUMAN_AUTH_XDG_RUNTIME_PATH, { recursive: true }),
      mkdir(WORK_DIRECTORY, { recursive: true }),
    ]);
    await chmod(HUMAN_AUTH_XDG_RUNTIME_PATH, 0o700);
    // Before Chromium's first launch: no "Save password?" bubble over the
    // sign-in the person is here to type.
    await disableChromiumPasswordManager(HUMAN_AUTH_PROFILE_PATH);
    if (isCancellationRequested()) {
      throw new CancellationError();
    }

    const env = {
      ...process.env,
      DISPLAY: HUMAN_AUTH_DISPLAY,
      HOME: HOME_DIRECTORY,
      XDG_RUNTIME_DIR: HUMAN_AUTH_XDG_RUNTIME_PATH,
    };
    await startViewerDisplay(services, env);

    await writeFile(HUMAN_AUTH_PASSWORD_PATH, `${vncPassword}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    vncPassword = "";
    const { x11vncArgs, websockifyArgs } = await startViewerServices(services, env, viewer, startUrl);
    // The saved sign-in first, then a refused capture's cookies over it: the
    // later write wins where both name a cookie.
    const saved = await preloadSavedState();
    if (saved.loaded) {
      emit("browser", "human_auth_state_preloaded", {
        mode: "human_auth",
        cookies: saved.cookies,
        message: "The Project's saved sign-in was loaded into the fresh viewer.",
      });
    }
    const preloaded = await preloadRefusedCandidate();
    if (preloaded.loaded) {
      emit("browser", "human_auth_state_preloaded", {
        mode: "human_auth",
        cookies: preloaded.cookies,
        message: "The refused capture's cookies were loaded into the fresh viewer.",
      });
    }
    await installKeyboardDiagnostics();
    if (trustedAccess) {
      trustedAccessNavigation = await startHumanTrustedAccessNavigation(productionUrl, trustedAccess);
    }
    // What the product holds before anyone signs in, for the capture to diff
    // against. Not awaited: the viewer is announced ready as soon as it is.
    startAnonymousBaseline(productionUrl);

    emit("browser", "human_auth_ready", {
      mode: "human_auth",
      containerPort: HUMAN_AUTH_WEB_PORT,
      path: "/vnc.html?autoconnect=1&resize=scale",
      message: "The isolated human-auth browser is ready for user takeover.",
    });
    await appendHumanAuthServiceLog("human_auth_ready; supervising viewer services");
    await superviseViewerServices({
      services, env, x11vncArgs, websockifyArgs, viewer, startUrl, restartPassword,
    });
  } catch (error) {
    if (!isCancellationRequested()) {
      await appendHumanAuthServiceLog(`viewer startup failed: ${safeError(error)}`);
      throw error;
    }
  } finally {
    vncPassword = "";
    restartPassword = "";
    try {
      await rm(HUMAN_AUTH_PASSWORD_PATH, { force: true });
    } finally {
      try {
        await captureSignedInStateOnTeardown(viewer, productionUrl);
        await trustedAccessNavigation?.close().catch(() => {});
        await viewer.browser?.close();
        await stopManagedServices(services);
      } finally {
        setHumanAuthServices(null);
      }
    }
  }
}
