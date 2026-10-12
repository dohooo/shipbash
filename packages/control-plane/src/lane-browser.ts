/**
 * The host's side of a browser-idle lane container (the sign-in takeover):
 * the agent-browser settings it starts with, and the one way the host names
 * the lane's browser in a `docker exec agent-browser` call. The lane writes the browser's CDP address to
 * LANE_BROWSER_CDP_URL_PATH once it listens (runner harness-browser.mjs); the
 * host reads it once per container and passes it as AGENT_BROWSER_CDP, with
 * the lanes' WebMCP setting (LANE_WEBMCP_ENV), so its calls join the browser
 * exactly as the lane's own do. A call that named it otherwise, or with
 * another WebMCP setting, would make the lane's agent-browser daemon join it
 * again, or start one that later calls do.
 */
import { LANE_BROWSER_CDP_URL_PATH, LANE_WEBMCP_ENV } from "@shipbash/contracts/runtime/browser-lane.mjs";

import { run } from "./init-browser-image.ts";

export interface LaneBrowserEnvInput {
  namespace: string;
  session: string;
  encryptionKey: string;
}

/** The `docker run` env of a browser-idle lane: its agent-browser session and settings. */
export function laneBrowserEnvArgs(input: LaneBrowserEnvInput): string[] {
  return [
    "--env", `AGENT_BROWSER_NAMESPACE=${input.namespace}`,
    "--env", `AGENT_BROWSER_SESSION=${input.session}`,
    "--env", "AGENT_BROWSER_CONTENT_BOUNDARIES=1",
    "--env", "AGENT_BROWSER_AUTOSAVE_INTERVAL_MS=0",
    "--env", "AGENT_BROWSER_MAX_OUTPUT=50000",
    "--env", `AGENT_BROWSER_ENCRYPTION_KEY=${input.encryptionKey}`,
  ];
}

export interface LaneBrowser {
  containerId: string;
  cdpUrl: string;
}

// A container's browser for as long as the container lives: browser-idle
// launches one and keeps it, and a new container is a new id.
const knownBrowsers = new Map<string, string>();

/** The address a lane wrote, if it is the browser's own local one. */
function laneCdpUrl(written: string): string | null {
  try {
    const url = new URL(written.trim());
    return url.protocol === "ws:" && url.hostname === "127.0.0.1" && url.port && url.pathname.startsWith("/devtools/browser/")
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** The lane container's id and its browser's CDP address, the address read once per container. */
export async function readLaneBrowser(dockerBinary: string, container: string): Promise<LaneBrowser> {
  const identity = await run(dockerBinary, ["inspect", "--format", "{{.Id}}", container]);
  const containerId = identity.stdout.trim();
  if (identity.exitCode !== 0 || !/^[a-f0-9]{64}$/u.test(containerId)) throw new Error("The browser lane is no longer available.");
  const known = knownBrowsers.get(containerId);
  if (known) return { containerId, cdpUrl: known };
  const written = await run(dockerBinary, ["exec", containerId, "cat", LANE_BROWSER_CDP_URL_PATH]);
  const cdpUrl = written.exitCode === 0 ? laneCdpUrl(written.stdout) : null;
  if (!cdpUrl) throw new Error("The browser lane's browser connection is unavailable.");
  knownBrowsers.set(containerId, cdpUrl);
  return { containerId, cdpUrl };
}

/** The `docker exec` argv of an agent-browser call into a lane, naming its browser as the lane does. */
export function laneAgentBrowserExec(browser: LaneBrowser, args: readonly string[], options: { interactive?: boolean } = {}): string[] {
  return [
    "exec",
    ...(options.interactive ? ["--interactive"] : []),
    "--env", `AGENT_BROWSER_CDP=${browser.cdpUrl}`,
    ...Object.entries(LANE_WEBMCP_ENV).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    browser.containerId,
    "agent-browser",
    ...args,
  ];
}
