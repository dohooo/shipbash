/** The suite owns its display services for the full container lifetime. */
import { chmod, mkdir } from "node:fs/promises";
import { DESKTOP_XDG_PATH, DESKTOP_XVFB_ARGS } from "../desktop-browser.mjs";
import { assertManagedServiceRunning, startManagedService, stopManagedServices, waitForPath } from "./processes.mjs";

export async function startSuiteDisplay(env) {
  await mkdir(DESKTOP_XDG_PATH, { recursive: true });
  await chmod(DESKTOP_XDG_PATH, 0o700);
  const services = [];
  try {
    const xvfb = startManagedService("Xvfb", "Xvfb", [...DESKTOP_XVFB_ARGS], env);
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
