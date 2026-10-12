/**
 * The browser a person signs in through by hand, in a Sandbox made for the
 * Project: the runner's browser-idle lane, headless, streamed through the
 * Sandbox's public port behind a capability path, driven through the control
 * lease this module writes into its mount, and asked for its session the way
 * the docker host asks — a request id on the control mount, the sealed answer
 * beside the key on the auth mount (runner sign-in-capture.mjs).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { decryptAgentBrowserState, encryptAgentBrowserState } from "@shipbash/control-plane/docker-runtime/auth-state";
import { HttpError } from "@shipbash/control-plane/service/http-input";
import { parseCaptureAnswer } from "@shipbash/control-plane/sign-in-capture";
import { browserStreamPath, sandboxBrowserStreamUrl } from "@shipbash/control-plane/vercel-sandbox-dispatch/origins";
import { ensureRuntime, type RuntimeBundle } from "@shipbash/control-plane/vercel-sandbox-dispatch/runtime-bundle";
import { SANDBOX_AGENT_GID, SANDBOX_AGENT_UID } from "@shipbash/control-plane/vercel-sandbox-dispatch/sandbox-agent-command";

import {
  AUTH_ROOT,
  ENCRYPTION_KEY_PATH,
  HOME_DIRECTORY,
  STATE_PATH,
  WORK_DIRECTORY,
} from "./production-human-auth-paths";
import {
  discardSandbox,
  runAsSandboxAgent,
  stopCommand,
  type ProductionHumanAuthSandbox,
  type ProductionHumanAuthSandboxFactory,
} from "./production-human-auth-sandbox";
import { savedState } from "./production-sandbox-slot";

/** The Sandbox's whole life: a person's sign-in, with room for a second factor. */
export const SIGN_IN_TAKEOVER_TIMEOUT_MS = 15 * 60_000;
const CAPTURE_TIMEOUT_MS = 60_000;
const CAPTURE_POLL_MS = 500;
const STREAM_PORT = 9224;
/** The lane's control root; its `sign-in` mount carries the lease and the capture request. */
const CONTROL_ROOT = "/shipbash/control/takeover";
const SIGN_IN_CONTROL_ROOT = `${CONTROL_ROOT}/sign-in`;
const CONTROL_LEASE_PATH = `${SIGN_IN_CONTROL_ROOT}/control-lease`;
const CAPTURE_REQUEST_PATH = `${SIGN_IN_CONTROL_ROOT}/capture-request`;
const CAPTURE_ANSWER_PATH = `${AUTH_ROOT}/sign-in-capture.json`;
const CAPTURE_STATE_PATH = `${AUTH_ROOT}/sign-in-capture.json.enc`;

export function projectDigest(projectId: string): string {
  return createHash("sha256").update(projectId).digest("hex");
}

/** The ephemeral Sandbox one takeover runs in: the Project named opaquely, the rest random. */
function takeoverSandboxName(projectId: string): string {
  return `shipbash-signin-${projectDigest(projectId).slice(0, 16)}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

/** 32 random bytes as 43 base64url characters: the shape of every control lease and stream capability. */
export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

interface OpenTakeoverBrowserInput {
  projectId: string;
  image: string;
  runtimeBundle: RuntimeBundle | null;
  /** How long the Sandbox may live before Vercel stops it, whoever forgets to. */
  timeoutMs: number;
  /** The Project's saved sign-in, for the browser to continue from; null starts it blank. */
  savedState: string | null;
  controlToken: string;
  startUrl: string | null;
  streamToken: string;
  /** The console's origin: the only Origin the stream accepts a viewer from. */
  allowedOrigin: string;
}

export interface OpenedTakeoverBrowser {
  sandbox: ProductionHumanAuthSandbox;
  commandId: string;
  streamUrl: string;
  /** Where the release's runner code is installed in this Sandbox. */
  runtimeDirectory: string;
  /** The key the browser's sessions are sealed under in this Sandbox. */
  encryptionKey: string;
}

/** Files the client writes, handed to the agent user the lane runs as. */
async function writeForAgent(
  sandbox: ProductionHumanAuthSandbox,
  files: Array<{ path: string; content: Buffer | string; mode?: number }>,
): Promise<void> {
  await sandbox.writeFiles(files);
  const owned = await sandbox.runCommand({
    cmd: "chown",
    args: [`${String(SANDBOX_AGENT_UID)}:${String(SANDBOX_AGENT_GID)}`, ...files.map((file) => file.path)],
  });
  if (owned.exitCode !== 0) throw new Error("The sign-in browser's files could not be handed to its user.");
}

/**
 * The Sandbox's auth and control mounts: a fresh key, the Project's saved
 * sign-in sealed under it when there is one, and the control lease the canvas
 * will present. Answers the key, which the lane seals its capture under.
 */
async function seedTakeoverSandbox(
  sandbox: ProductionHumanAuthSandbox,
  input: Pick<OpenTakeoverBrowserInput, "savedState" | "controlToken">,
): Promise<string> {
  const key = randomBytes(32).toString("hex");
  const state = savedState(input.savedState);
  const prepared = await runAsSandboxAgent(sandbox, {
    cmd: "mkdir",
    args: ["-p", AUTH_ROOT, SIGN_IN_CONTROL_ROOT, HOME_DIRECTORY, WORK_DIRECTORY],
  });
  if (prepared.exitCode !== 0) throw new Error("The sign-in browser could not prepare its Sandbox.");
  await writeForAgent(sandbox, [
    { path: ENCRYPTION_KEY_PATH, content: `${key}\n`, mode: 0o600 },
    { path: CONTROL_LEASE_PATH, content: `${input.controlToken}\n`, mode: 0o600 },
    ...(state ? [{ path: STATE_PATH, content: encryptAgentBrowserState(state, key), mode: 0o600 }] : []),
  ]);
  return key;
}

/** The stream gateway answers on its port once the browser is open and the lane is streaming it. */
async function waitForStream(sandbox: ProductionHumanAuthSandbox): Promise<void> {
  const result = await sandbox.runCommand({
    cmd: "bash",
    args: [
      "-c",
      `n=0; until curl --silent --output /dev/null http://127.0.0.1:${String(STREAM_PORT)}/; do n=$((n + 1)); if [ "$n" -ge 180 ]; then exit 1; fi; sleep 0.5; done`,
    ],
  });
  if (result.exitCode !== 0) throw new Error("The sign-in browser did not become ready.");
}

/** Starts the lane and answers with its command, once its stream answers. */
async function startLane(
  sandbox: ProductionHumanAuthSandbox,
  input: OpenTakeoverBrowserInput,
  runtimeDirectory: string,
  key: string,
): Promise<string> {
  const command = await runAsSandboxAgent(sandbox, {
    cmd: "node",
    args: [`${runtimeDirectory}/suite-runner.mjs`, "browser-idle"],
    cwd: WORK_DIRECTORY,
    detached: true,
    env: {
      SHIPBASH_RUNTIME_ROOT: "/shipbash",
      SHIPBASH_RUNTIME_DIRECTORY: runtimeDirectory,
      SHIPBASH_CONTROL_ROOT: CONTROL_ROOT,
      SHIPBASH_AUTH_ROOT: AUTH_ROOT,
      SHIPBASH_WORK_DIRECTORY: WORK_DIRECTORY,
      SHIPBASH_HOME_DIRECTORY: HOME_DIRECTORY,
      // The takeover's fixed role: headless, and the lane's capture watcher on.
      SHIPBASH_BROWSER_ID: "sign-in-takeover",
      ...(input.startUrl ? { SHIPBASH_BROWSER_URL: input.startUrl } : {}),
      AGENT_BROWSER_NAMESPACE: `signin_${projectDigest(input.projectId).slice(0, 12)}`,
      AGENT_BROWSER_SESSION: "sign-in",
      AGENT_BROWSER_ENCRYPTION_KEY: key,
      // The gateway serves the Sandbox's public port behind this path, to this origin only.
      SHIPBASH_BROWSER_STREAM_PATH: browserStreamPath(input.streamToken),
      SHIPBASH_BROWSER_STREAM_ALLOWED_ORIGIN: input.allowedOrigin,
      SHIPBASH_BROWSER_STREAM_PUBLIC_PORT: String(STREAM_PORT),
    },
  });
  try {
    await waitForStream(sandbox);
    return command.cmdId;
  } catch (error) {
    await stopCommand(command, "SIGKILL").catch(() => undefined);
    throw error;
  }
}

/** The stream as the canvas dials it: the Sandbox's public port, over WebSocket, behind the capability path. */
function viewerStreamUrl(sandbox: ProductionHumanAuthSandbox, streamToken: string): string {
  const url = new URL(sandboxBrowserStreamUrl(sandbox.domain(STREAM_PORT), browserStreamPath(streamToken)));
  url.protocol = "wss:";
  return url.href;
}

/** A Sandbox created from the runner image, seeded, its lane started and streaming; discarded on any failure. */
export async function openTakeoverBrowser(
  factory: ProductionHumanAuthSandboxFactory,
  input: OpenTakeoverBrowserInput,
): Promise<OpenedTakeoverBrowser> {
  const sandbox = await factory.create({
    name: takeoverSandboxName(input.projectId),
    image: input.image,
    timeout: input.timeoutMs,
    ports: [STREAM_PORT],
    persistent: false,
  });
  try {
    const runtimeDirectory = await ensureRuntime(sandbox, input.runtimeBundle);
    const encryptionKey = await seedTakeoverSandbox(sandbox, input);
    const commandId = await startLane(sandbox, input, runtimeDirectory, encryptionKey);
    return { sandbox, commandId, streamUrl: viewerStreamUrl(sandbox, input.streamToken), runtimeDirectory, encryptionKey };
  } catch (error) {
    await discardSandbox(sandbox);
    throw error;
  }
}

interface CapturedTakeoverSession {
  state: Record<string, unknown>;
  /** The GitHub account the captured jar's HttpOnly github.com cookies name. */
  githubAccountLogin: string | null;
}

/**
 * Asks the lane to seal what its browser holds and answers with that state,
 * opened with the Sandbox's own key, and the GitHub account it names. The
 * request id is what makes the pair safe: an answer naming a different
 * request is an older capture.
 */
export async function captureTakeoverSession(sandbox: ProductionHumanAuthSandbox): Promise<CapturedTakeoverSession> {
  const requestId = randomBytes(16).toString("base64url");
  await writeForAgent(sandbox, [{ path: CAPTURE_REQUEST_PATH, content: `${requestId}\n`, mode: 0o600 }]);
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const raw = await sandbox.readTextFile(CAPTURE_ANSWER_PATH).catch(() => null);
    const answer = raw === null ? null : parseCaptureAnswer(raw);
    if (answer?.requestId === requestId) {
      if (!answer.ok) {
        throw new HttpError(409, "SIGN_IN_CAPTURE_FAILED", answer.message?.trim() || "The sign-in browser could not save this session.");
      }
      const [sealed, key] = await Promise.all([
        sandbox.readFile(CAPTURE_STATE_PATH).catch(() => null),
        sandbox.readTextFile(ENCRYPTION_KEY_PATH).catch(() => null),
      ]);
      if (!sealed?.byteLength || !key?.trim()) throw new Error("The sign-in browser answered without a saved session.");
      return { state: decryptAgentBrowserState(sealed, key.trim()), githubAccountLogin: answer.githubAccountLogin };
    }
    await delay(CAPTURE_POLL_MS);
  }
  throw new HttpError(409, "SIGN_IN_CAPTURE_FAILED", "The sign-in browser did not save this session in time.");
}
