import { DESKTOP_XVFB_ARGS } from "../desktop-browser.mjs";
// Display management for the headed Activity browser: the Xvfb/Openbox
// display stack and the X11 window helpers that size the takeover-visible
// Chromium.
import { randomBytes } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  HUMAN_AUTH_DISPLAY,
  HUMAN_AUTH_XDG_RUNTIME_PATH,
} from "./environment.mjs";
import { checkCancellation } from "./state.mjs";
import {
  assertManagedServiceRunning,
  runProcess,
  startManagedService,
  stopManagedServices,
  waitForPath,
} from "./processes.mjs";

export function humanAuthPassword(env = process.env) {
  const configured = env.SHIPBASH_HUMAN_AUTH_PASSWORD;
  const password = configured === undefined
    ? randomBytes(24).toString("base64url")
    : configured;
  if (!password.trim() || /[\0\r\n]/u.test(password)) {
    throw new Error("SHIPBASH_HUMAN_AUTH_PASSWORD must be a non-empty single-line string.");
  }
  if (Buffer.byteLength(password, "utf8") > 1_024) {
    throw new Error("SHIPBASH_HUMAN_AUTH_PASSWORD must be at most 1024 bytes.");
  }
  return password;
}

export async function startActivityDisplay(env) {
  await mkdir(HUMAN_AUTH_XDG_RUNTIME_PATH, { recursive: true });
  await chmod(HUMAN_AUTH_XDG_RUNTIME_PATH, 0o700);
  const services = [];
  try {
    const xvfb = startManagedService(
      "Xvfb",
      "Xvfb",
      [...DESKTOP_XVFB_ARGS],
      env,
    );
    services.push(xvfb);
    await waitForPath("/tmp/.X11-unix/X99", xvfb);
    const openbox = startManagedService("Openbox", "openbox", ["--sm-disable"], env);
    services.push(openbox);
    await assertManagedServiceRunning(openbox);
    return services;
  } catch (error) {
    await stopManagedServices(services);
    throw error;
  }
}

export function activityBrowserWindowFromXwininfo(stdout) {
  for (const line of String(stdout).split(/\r?\n/u)) {
    if (!/\(\s*"chromium[^"]*"\s+"Chromium"\s*\)/iu.test(line)) continue;
    const dimensions = line.match(/\s(\d+)x(\d+)[+-]-?\d+[+-]-?\d+\s/u);
    if (!dimensions) continue;
    const width = Number(dimensions[1]);
    const height = Number(dimensions[2]);
    // Chromium also creates 10x10 clipboard/helper windows. Only the mapped
    // top-level browser is suitable for a human takeover.
    if (width >= 320 && height >= 240) return { width, height };
  }
  return null;
}

async function readActivityBrowserWindow(env) {
  const result = await runProcess(
    "xwininfo",
    ["-root", "-tree", "-display", HUMAN_AUTH_DISPLAY],
    {
      env,
      cancelable: false,
      timeoutMs: 5_000,
      logStderr: false,
    },
  );
  if (result.timedOut || result.code !== 0) return null;
  return activityBrowserWindowFromXwininfo(result.stdout);
}

export async function waitForActivityBrowserWindow(env, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    checkCancellation();
    const browserWindow = await readActivityBrowserWindow(env);
    if (browserWindow) return browserWindow;
    await delay(100);
  }
  throw new Error("Interactive Chromium window was not available on the Activity display.");
}

export async function maximizeActivityBrowserWindow(env) {
  const result = await runProcess(
    "wmctrl",
    ["-x", "-r", "Chromium", "-b", "add,maximized_vert,maximized_horz"],
    {
      env,
      cancelable: false,
      timeoutMs: 5_000,
      logStderr: false,
    },
  );
  if (result.timedOut || result.code !== 0) {
    throw new Error("Interactive Chromium window could not be maximized on the Activity display.");
  }
  await delay(100);
  return waitForActivityBrowserWindow(env);
}
