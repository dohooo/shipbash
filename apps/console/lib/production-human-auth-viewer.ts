/**
 * Starting the browser the person actually signs in through, in a Sandbox
 * made for it.
 *
 * The Sandbox is fresh, so it is first handed what the person continues
 * from: a key of its own and, when the Project has one, the saved sign-in
 * sealed under that key, which the runner's human-auth lane loads into the
 * viewer's browser. Then the viewer — Xvfb, a window manager, x11vnc, noVNC
 * and Chromium — is started and waited for long enough for the stack to
 * answer.
 */
import { createHash, randomBytes } from "node:crypto";

import { encryptAgentBrowserState } from "@shipbash/control-plane/docker-runtime/auth-state";
import { SANDBOX_AGENT_GID, SANDBOX_AGENT_UID } from "@shipbash/control-plane/vercel-sandbox-dispatch/sandbox-agent-command";
import { hostedConfiguration } from "@shipbash/control-plane/configuration";
import { sandboxAgentEnvironment } from "@shipbash/control-plane/vercel-sandbox-network-policy";

import type { ScopedAuthInput } from "./production-human-auth-identity";
import {
  AUTH_ROOT,
  CONTROL_ROOT,
  ENCRYPTION_KEY_PATH,
  HOME_DIRECTORY,
  STATE_PATH,
  WORK_DIRECTORY,
} from "./production-human-auth-paths";
import {
  runAsSandboxAgent,
  stopCommand,
  type ProductionHumanAuthSandbox,
} from "./production-human-auth-sandbox";
import { savedState } from "./production-sandbox-slot";

/**
 * The Sandbox's auth directory: a fresh key, and the Project's saved sign-in
 * sealed under it when there is one. The files are written by the client
 * and then handed to the agent user the viewer runs as.
 */
export async function seedAuthDirectory(
  sandbox: ProductionHumanAuthSandbox,
  stateJsonText: string | null,
): Promise<void> {
  const key = randomBytes(32).toString("hex");
  const state = savedState(stateJsonText);
  const files = [
    { path: ENCRYPTION_KEY_PATH, content: `${key}\n`, mode: 0o600 },
    ...(state ? [{ path: STATE_PATH, content: encryptAgentBrowserState(state, key), mode: 0o600 }] : []),
  ];
  const prepared = await runAsSandboxAgent(sandbox, {
    cmd: "mkdir",
    args: ["-p", AUTH_ROOT, CONTROL_ROOT, HOME_DIRECTORY, WORK_DIRECTORY],
  });
  if (prepared.exitCode !== 0) throw new Error("The authentication handoff could not prepare the Sandbox.");
  await sandbox.writeFiles(files);
  const owned = await sandbox.runCommand({
    cmd: "chown",
    args: [`${String(SANDBOX_AGENT_UID)}:${String(SANDBOX_AGENT_GID)}`, ...files.map((file) => file.path)],
  });
  if (owned.exitCode !== 0) throw new Error("The authentication handoff could not seed the Sandbox's sign-in.");
}

async function waitForViewer(sandbox: ProductionHumanAuthSandbox): Promise<void> {
  // A cold Sandbox has to boot Xvfb, the window manager, x11vnc, noVNC and
  // Chromium before the viewer answers. That routinely takes far longer than a
  // few seconds, so poll for up to ~90s (well under the 300s Function limit).
  const result = await sandbox.runCommand({
    cmd: "bash",
    args: [
      "-c",
      "n=0; until curl --fail --silent --output /dev/null http://127.0.0.1:6080/vnc.html; do n=$((n + 1)); if [ \"$n\" -ge 180 ]; then exit 1; fi; sleep 0.5; done",
    ],
  });
  if (result.exitCode !== 0) throw new Error("The authentication viewer did not become ready.");
}

/** The viewer's browser id: the target, named opaquely. */
function browserId(input: ScopedAuthInput): string {
  return createHash("sha256").update(input.targetKind).update("\0").update(input.targetId).digest("base64url").slice(0, 24);
}

/** Starts the viewer and answers with the command showing it, once it answers on its port. */
export async function startViewer(
  sandbox: ProductionHumanAuthSandbox,
  input: ScopedAuthInput & { productionUrl: string },
  runtimeDirectory: string,
  password: string,
): Promise<string> {
  const command = await runAsSandboxAgent(sandbox, {
    cmd: "node",
    args: [`${runtimeDirectory}/suite-runner.mjs`, "human-auth"],
    cwd: WORK_DIRECTORY,
    detached: true,
    env: {
      SHIPBASH_HUMAN_AUTH_URL: input.productionUrl,
      SHIPBASH_HUMAN_AUTH_PASSWORD: password,
      SHIPBASH_BROWSER_ID: `auth-${browserId(input)}`,
      SHIPBASH_RUNTIME_ROOT: "/shipbash",
      SHIPBASH_RUNTIME_DIRECTORY: runtimeDirectory,
      SHIPBASH_CONTROL_ROOT: CONTROL_ROOT,
      SHIPBASH_AUTH_ROOT: AUTH_ROOT,
      SHIPBASH_WORK_DIRECTORY: WORK_DIRECTORY,
      SHIPBASH_HOME_DIRECTORY: HOME_DIRECTORY,
      // Jev judges the product page the capture seals by (human-auth-page.mjs),
      // with the key the Sandbox's firewall adds.
      ...sandboxAgentEnvironment(hostedConfiguration()),
    },
  });
  try {
    await waitForViewer(sandbox);
    return command.cmdId;
  } catch (error) {
    await stopCommand(command, "SIGKILL").catch(() => undefined);
    throw error;
  }
}
