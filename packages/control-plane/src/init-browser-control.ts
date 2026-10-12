/**
 * The sign-in takeover browser: a browser-idle container with a bind mount of
 * the control directory the server mints the screencast control lease into.
 * That mount is the entire difference between a stream a person watches and a
 * browser a person drives. A sign-in belongs to one Project and has to start,
 * be driven, and be thrown away on its own.
 */
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { ensureCanonicalDefaultAuthPaths } from "./auth-path.ts";
import {
  SHIPBASH_CONTAINER_ROLE_LABEL,
  SHIPBASH_MANAGED_LABEL,
  SHIPBASH_PROJECT_HASH_LABEL,
} from "./docker-runtime.ts";
import { ensureEncryptionKey } from "./init-browser-auth-state.ts";
import { run } from "./init-browser-image.ts";
import { laneAgentBrowserExec, laneBrowserEnvArgs, readLaneBrowser } from "./lane-browser.ts";

const BROWSER_READY_TIMEOUT_MS = 30_000;

async function publishedStreamUrl(dockerBinary: string, name: string): Promise<string | null> {
  const port = await run(dockerBinary, ["port", name, "9224/tcp"]);
  if (port.exitCode !== 0) return null;
  const match = port.stdout.match(/127\.0\.0\.1:(\d+)/);
  return match ? `ws://127.0.0.1:${match[1]}` : null;
}

async function waitForBrowserContainerReady(dockerBinary: string, name: string): Promise<string> {
  const deadline = Date.now() + BROWSER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await run(dockerBinary, [
      "inspect",
      "--format",
      "{{.State.Running}}|{{.State.ExitCode}}",
      name,
    ]);
    if (state.exitCode !== 0) {
      throw new Error("Docker browser lane disappeared before it became ready.");
    }
    const [running, exitCode] = state.stdout.trim().split("|");
    const logs = await run(dockerBinary, ["logs", "--tail", "200", name]);
    if (`${logs.stdout}\n${logs.stderr}`.includes('"type":"browser_idle_ready"')) {
      const streamUrl = await publishedStreamUrl(dockerBinary, name);
      if (streamUrl) return streamUrl;
    }
    if (running !== "true") {
      throw new Error(
        `Docker browser lane exited before it became ready (exit code ${exitCode || "unknown"}).`,
      );
    }
    await delay(100);
  }
  throw new Error("Docker browser lane did not become ready within 30 seconds.");
}

/** Internal endpoint of the exact project browser; never accepted from an HTTP client. */
export async function readSignInBrowserEndpoint(dockerBinary: string, name: string): Promise<{ containerId: string; cdpUrl: string }> {
  return readLaneBrowser(dockerBinary, name);
}

/** Change provider within the same project browser, without replacing its process. */
export async function navigateSignInBrowser(dockerBinary: string, name: string, url: string): Promise<void> {
  const result = await run(dockerBinary, laneAgentBrowserExec(await readLaneBrowser(dockerBinary, name), ["open", url, "--json"]));
  if (result.exitCode !== 0) throw new Error("The sign-in page could not be opened in this browser.");
}

export const SIGN_IN_TAKEOVER_CONTAINER_ROLE = "sign-in-takeover";

/** Deterministic, so a container stranded by a crashed service is found again by name. */
export function signInTakeoverContainerName(projectId: string): string {
  return `shipbash-signin-${createHash("sha256").update(projectId).digest("hex").slice(0, 12)}`;
}

export interface SignInTakeoverContainerArgsInput {
  name: string;
  image: string;
  projectHash: string;
  authDirectory: string;
  controlDirectory: string;
  encryptionKey: string;
  /** The page the browser opens on, usually the Project's Production URL. */
  startUrl: string | null;
  uid: number;
  gid: number;
}

/**
 * The `docker run` argv: read-only root, every capability dropped, no
 * privilege escalation, tmpfs for the writable paths, and the control mount
 * READ-ONLY: the host writes the lease, the container only ever reads it.
 */
export function signInTakeoverContainerArgs(input: SignInTakeoverContainerArgsInput): string[] {
  const { uid, gid } = input;
  return [
    "run",
    "--detach",
    "--init",
    "--name",
    input.name,
    "--label",
    `${SHIPBASH_MANAGED_LABEL}=true`,
    "--label",
    `${SHIPBASH_PROJECT_HASH_LABEL}=${input.projectHash}`,
    "--label",
    `${SHIPBASH_CONTAINER_ROLE_LABEL}=${SIGN_IN_TAKEOVER_CONTAINER_ROLE}`,
    "--user",
    `${String(uid)}:${String(gid)}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    `type=bind,src=${input.authDirectory},dst=/shipbash/control/auth`,
    "--mount",
    `type=bind,src=${input.controlDirectory},dst=/shipbash/control/sign-in,readonly`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,mode=1777,size=1g",
    "--tmpfs",
    `/shipbash/home:rw,nosuid,nodev,mode=0700,uid=${String(uid)},gid=${String(gid)}`,
    "--tmpfs",
    `/shipbash/work:rw,nosuid,nodev,mode=0700,uid=${String(uid)},gid=${String(gid)}`,
    "--tmpfs",
    `/run/agent-browser:rw,nosuid,nodev,mode=0700,uid=${String(uid)},gid=${String(gid)}`,
    "--publish",
    "127.0.0.1::9224/tcp",
    ...laneBrowserEnvArgs({
      namespace: `signin_${input.projectHash.slice(0, 12)}`,
      session: "sign-in",
      encryptionKey: input.encryptionKey,
    }),
    "--env",
    "SHIPBASH_BROWSER_ID=sign-in-takeover",
    ...(input.startUrl ? ["--env", `SHIPBASH_BROWSER_URL=${input.startUrl}`] : []),
    "--entrypoint",
    "node",
    input.image,
    "/shipbash/runtime/suite-runner.mjs",
    "browser-idle",
  ];
}

export interface SignInTakeoverContainerInput {
  dockerBinary: string;
  image: string;
  projectId: string;
  projectHash: string;
  /** The Project's own state directory; its auth/default holds the sign-in bytes. */
  stateDirectory: string;
  authDirectory: string;
  controlDirectory: string;
  startUrl: string | null;
}

export interface SignInTakeoverContainer {
  name: string;
  streamUrl: string;
}

/**
 * Starts the Project's takeover browser and waits for its stream. Any
 * container left behind by an earlier service life is removed first: its
 * published port and its lease are both gone, so joining it would hand the
 * viewer a socket nobody can control.
 */
export async function startSignInTakeoverContainer(
  input: SignInTakeoverContainerInput,
): Promise<SignInTakeoverContainer> {
  const name = signInTakeoverContainerName(input.projectId);
  await run(input.dockerBinary, ["rm", "--force", name]);
  const authPaths = await ensureCanonicalDefaultAuthPaths(input.stateDirectory, input.authDirectory);
  const created = await run(
    input.dockerBinary,
    signInTakeoverContainerArgs({
      name,
      image: input.image,
      projectHash: input.projectHash,
      authDirectory: authPaths.authDirectory,
      controlDirectory: input.controlDirectory,
      encryptionKey: await ensureEncryptionKey(authPaths.authDirectory),
      startUrl: input.startUrl,
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    }),
  );
  if (created.exitCode !== 0) {
    throw new Error(`The sign-in browser failed to start: ${created.stderr.trim()}`);
  }
  try {
    return { name, streamUrl: await waitForBrowserContainerReady(input.dockerBinary, name) };
  } catch (error) {
    await run(input.dockerBinary, ["rm", "--force", name]);
    throw error;
  }
}

/** The published stream of a takeover container still running, or null. */
export async function signInTakeoverStreamUrl(
  dockerBinary: string,
  name: string,
): Promise<string | null> {
  const state = await run(dockerBinary, ["inspect", "--format", "{{.State.Running}}", name]);
  if (state.exitCode !== 0 || state.stdout.trim() !== "true") return null;
  return publishedStreamUrl(dockerBinary, name);
}

export async function stopSignInTakeoverContainer(dockerBinary: string, name: string): Promise<void> {
  await run(dockerBinary, ["rm", "--force", name]);
}
