/**
 * The one place a browser is launched and ended: the case attempt's, the
 * Activity leg's, browser-idle's, the human-auth viewer's and the replay
 * export's terminal page (terminal-page.mjs). The harness
 * starts Chromium itself as agent-browser 0.38.1 did, and every agent-browser
 * call joins it through AGENT_BROWSER_CDP (agent-browser-cli.mjs and the MCP
 * proxy refuse to run without it). agent-browser then cannot launch, replace
 * or orphan a browser: a daemon that dies or restarts joins the same one
 * again, a crash is final rather than covered over by a fresh about:blank,
 * and a stall no longer costs the browser to a liveness check (measured
 * scenario by scenario). The side that launched the browser ends
 * it, by its process group.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { DESKTOP_BROWSER_ARGS } from "./desktop-browser.mjs";

export const CHROMIUM_PATH = "/usr/bin/chromium";

/**
 * The flags agent-browser 0.38.1 launched Chromium with, from its
 * `build_chrome_args` (cli/src/native/cdp/chrome.rs), for the options the
 * runner used: a debugging port Chromium picks and writes to
 * DevToolsActivePort, no WebMCP (the lanes run it off, contracts
 * browser-lane.mjs LANE_WEBMCP_ENV), no WebGPU, no proxy, extensions, profile
 * or CA certificate, and a mock keychain. Kept so a page behaves as it did
 * when agent-browser launched it; an agent-browser upgrade means
 * comparing this list against its `build_chrome_args`.
 */
export const AGENT_BROWSER_FLAGS = Object.freeze([
  "--remote-debugging-port=0",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-backgrounding-occluded-windows",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-hang-monitor",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-sync",
  "--disable-features=Translate",
  "--enable-features=NetworkService,NetworkServiceInProcess",
  "--metrics-recording-only",
  "--password-store=basic",
  "--use-mock-keychain",
]);
/** What agent-browser 0.38.1 added for a headless launch: new headless mode, no painted scrollbars, software GL. */
const HEADLESS_FLAGS = Object.freeze(["--headless=new", "--hide-scrollbars", "--enable-unsafe-swiftshader"]);
/** agent-browser 0.38.1's `should_disable_sandbox` and `should_disable_dev_shm`, for a container. */
const CONTAINER_FLAGS = Object.freeze(["--no-sandbox", "--disable-dev-shm-usage"]);
/**
 * agent-browser 0.38.1's `launch_chrome`: three attempts, 500 ms apart, each
 * given 30 s to write DevToolsActivePort. A cold Sandbox's first Chromium can
 * take far longer than a warm one's to listen.
 */
const LAUNCH_ATTEMPTS = 3;
const LAUNCH_ATTEMPT_TIMEOUT_MS = 30_000;
const LAUNCH_RETRY_DELAY_MS = 500;

/**
 * Whether this process runs where agent-browser 0.38.1 turned Chromium's
 * sandbox and /dev/shm off: CI, root, or a Docker, Podman or cgroup-named
 * container.
 * @param {{ env?: Record<string, string | undefined>, euid?: number, exists?: (path: string) => boolean, read?: (path: string, encoding: "utf8") => string }} [probe]
 */
export function runsContainerised({ env = process.env, euid = process.geteuid?.() ?? -1, exists = existsSync, read = readFileSync } = {}) {
  if (env.CI !== undefined || euid === 0 || exists("/.dockerenv") || exists("/run/.containerenv")) return true;
  try {
    return /docker|kubepods|lxc/u.test(read("/proc/1/cgroup", "utf8"));
  } catch {
    return false;
  }
}

/**
 * Chromium's command line for a harness browser: agent-browser's flags, the
 * lane's own (`extraArgs`), then the page it opens on.
 * @param {{ userDataDir: string, headless: boolean, extraArgs?: readonly string[], containerised: boolean, startUrl?: string }} options
 */
export function harnessBrowserArgs({ userDataDir, headless, extraArgs = [], containerised, startUrl = "about:blank" }) {
  const sized = extraArgs.some((arg) => ["--start-maximized", "--window-size=", "--kiosk"].some((flag) => arg.startsWith(flag)));
  return [
    ...AGENT_BROWSER_FLAGS,
    ...(headless ? HEADLESS_FLAGS : []),
    `--user-data-dir=${userDataDir}`,
    ...(headless && !sized ? ["--window-size=1280,720"] : []),
    ...extraArgs,
    ...(containerised ? CONTAINER_FLAGS : []),
    startUrl,
  ];
}

/** The CDP address a listening Chromium wrote into its profile, or null. */
async function activePortUrl(userDataDir) {
  const [port, browserPath] = (await readFile(join(userDataDir, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n");
  return port && browserPath?.startsWith("/devtools/browser/") ? `ws://127.0.0.1:${port}${browserPath}` : null;
}

/** Signals a browser's whole process group; a group already gone is no error. */
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/**
 * One launch: Chromium in a process group of its own, answered once it
 * listens (DevToolsActivePort, as agent-browser reads it). A launch that does
 * not listen in time, or exits first, is killed and reported with the end of
 * what it printed.
 */
async function launchOnce({ executable, args, env, userDataDir, timeoutMs }) {
  await rm(join(userDataDir, "DevToolsActivePort"), { force: true });
  const child = spawn(executable, args, { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  // The harness ends the browser itself; a running one never holds the harness's own exit.
  child.unref();
  let printed = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    printed = (printed + chunk).slice(-2_000);
  });
  if ("unref" in child.stderr && typeof child.stderr.unref === "function") child.stderr.unref();
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
  });
  let ended = null;
  void exited.then((result) => {
    ended = result;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !ended) {
    const cdpUrl = await activePortUrl(userDataDir);
    if (cdpUrl) return { cdpUrl, pid: child.pid, exited, running: () => !ended };
    await delay(50);
  }
  const early = ended;
  if (!early && child.pid) {
    signalGroup(child.pid, "SIGKILL");
    await Promise.race([exited, delay(2_000)]);
  }
  const why = early ? `exited before it listened for CDP (${early.error?.message ?? early.signal ?? `code ${String(early.code)}`})` : "did not listen for CDP in time";
  throw new Error(`Chromium ${why}.${printed.trim() ? ` Its last output: ${printed.trim().slice(-500)}` : ""}`);
}

/** A file's text, or null when it is not there; any other failure is the caller's to hear. */
async function readIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Whether /proc shows `pid` as agent-browser's daemon filed under `session`:
 * agent-browser's binary as its one argument, and the daemon's environment
 * (AGENT_BROWSER_DAEMON=1) naming this socket dir, namespace and session. A
 * process that is gone, or already dead and unreaped, is not; neither is a
 * pid the kernel handed to anything else since. The command line is read
 * first: any process's is readable, another user's environment is not.
 */
async function isLaneDaemon(pid, { socketDir, namespace, session }) {
  const args = (await readIfPresent(`/proc/${String(pid)}/cmdline`))?.split("\0").filter(Boolean) ?? [];
  if (args.length !== 1 || basename(args[0]) !== "agent-browser") return false;
  const environment = new Set((await readIfPresent(`/proc/${String(pid)}/environ`))?.split("\0") ?? []);
  return ["AGENT_BROWSER_DAEMON=1", `AGENT_BROWSER_SOCKET_DIR=${socketDir}`, `AGENT_BROWSER_NAMESPACE=${namespace}`, `AGENT_BROWSER_SESSION=${session}`]
    .every((entry) => environment.has(entry));
}

/**
 * Every agent-browser daemon of the env's namespace, killed: it only drops a
 * connection now, and one frozen with its browser would never hear a
 * `close`. agent-browser 0.38.1 keeps each daemon's pid beside its socket
 * (<socket dir>/namespaces/<namespace>/run/<session>.pid), and a daemon is
 * its own session and process group with no children, so the pid is the
 * whole of it; it is killed only once isLaneDaemon confirms it. The run
 * directory goes after them: a namespace (browser-idle, sign-in-login) is
 * used again in the same container, and a pid file left behind could name a
 * process the pid was handed to since. Only a daemon that exited on its own
 * meanwhile (ESRCH) is passed over in silence.
 */
async function endDaemons(env) {
  const { AGENT_BROWSER_SOCKET_DIR: socketDir, AGENT_BROWSER_NAMESPACE: namespace } = env;
  if (!socketDir || !namespace) return;
  const run = join(socketDir, "namespaces", namespace, "run");
  let names;
  try {
    names = await readdir(run);
  } catch (error) {
    // No daemon ever ran in this namespace.
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const name of names.filter((entry) => entry.endsWith(".pid"))) {
    const session = name.slice(0, -".pid".length);
    const pid = Number((await readIfPresent(join(run, name)))?.trim());
    if (!Number.isInteger(pid) || pid < 1 || !await isLaneDaemon(pid, { socketDir, namespace, session })) continue;
    try {
      process.kill(pid, "SIGKILL");
      process.stderr.write(`[shipbash-harness-browser] agent-browser daemon ${String(pid)} of ${namespace}/${session} killed\n`);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  await rm(run, { recursive: true, force: true });
}

/**
 * Launches the lane's browser, as agent-browser 0.38.1 did (three attempts),
 * and answers once it listens for CDP. `env` gains AGENT_BROWSER_CDP, the
 * browser's own address, which every agent-browser call names it by: the
 * lane's own, its MCP lane's, and the host's `docker exec` calls into a lane
 * that writes it at `announcePath` for them (browser-idle:
 * LANE_BROWSER_CDP_URL_PATH). agent-browser counts that name, with the WebMCP
 * setting every call carries (LANE_WEBMCP_ENV), in its connection's identity:
 * a call that named the browser otherwise would make the daemon join it again
 * and renumber every element ref. The address, unlike a port, also rides out a stalled browser, where
 * the port's discovery gives up after some 9 s.
 *
 * `close` ends the browser by its process group, SIGTERM then SIGKILL, frozen
 * or not, then kills every agent-browser daemon of the lane's namespace
 * (endDaemons), and removes a profile of its own making; it never waits on the
 * browser or a daemon, and nothing cancels it. A daemon it could not end is
 * its error, once the profile and the announced address are gone.
 * `extraArgs` are the caller's own flags, after the desktop's.
 * @param {{ env: NodeJS.ProcessEnv, desktop: boolean, extraArgs?: readonly string[], userDataDir?: string | null, startUrl?: string, announcePath?: string | null, executable?: string, attemptTimeoutMs?: number, retryDelayMs?: number }} options
 * @returns {Promise<{ cdpUrl: string, pid: number, running: () => boolean, exited: Promise<unknown>, close: () => Promise<void> }>}
 */
export async function launchHarnessBrowser({
  env, desktop, extraArgs = [], userDataDir = null, startUrl, announcePath = null, executable = CHROMIUM_PATH,
  attemptTimeoutMs = LAUNCH_ATTEMPT_TIMEOUT_MS, retryDelayMs = LAUNCH_RETRY_DELAY_MS,
}) {
  const containerised = runsContainerised({ env });
  let lastError = null;
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt += 1) {
    const profile = userDataDir ?? await mkdtemp(join(tmpdir(), "shipbash-browser-"));
    const args = harnessBrowserArgs({ userDataDir: profile, headless: !desktop, extraArgs: [...(desktop ? DESKTOP_BROWSER_ARGS : []), ...extraArgs], containerised, startUrl });
    try {
      const launched = await launchOnce({ executable, args, env, userDataDir: profile, timeoutMs: attemptTimeoutMs });
      return await announced(launched, { env, ownedProfile: userDataDir ? null : profile, announcePath });
    } catch (error) {
      lastError = error;
      if (!userDataDir) await rm(profile, { recursive: true, force: true }).catch(() => {});
      if (attempt < LAUNCH_ATTEMPTS) await delay(retryDelayMs);
    }
  }
  throw lastError;
}

/** The launched browser, named in `env` and for the host, with its one way to end. */
async function announced(launched, { env, ownedProfile, announcePath }) {
  let closed = null;
  const close = () => {
    closed ??= (async () => {
      signalGroup(launched.pid, "SIGTERM");
      if (!await Promise.race([launched.exited, delay(2_000).then(() => null)])) {
        signalGroup(launched.pid, "SIGKILL");
        await Promise.race([launched.exited, delay(2_000)]);
      }
      try {
        await endDaemons(env);
      } finally {
        if (ownedProfile) await rm(ownedProfile, { recursive: true, force: true }).catch(() => {});
        if (announcePath && (await readFile(announcePath, "utf8").catch(() => "")).trim() === launched.cdpUrl) await rm(announcePath, { force: true });
      }
    })();
    return closed;
  };
  if (announcePath) {
    try {
      await mkdir(dirname(announcePath), { recursive: true });
      await writeFile(announcePath, `${launched.cdpUrl}\n`, { mode: 0o600 });
    } catch (error) {
      await close();
      throw error;
    }
  }
  env.AGENT_BROWSER_CDP = launched.cdpUrl;
  return { ...launched, close };
}
