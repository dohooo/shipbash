/**
 * The runner's code layer, shipped apart from its image. Every release
 * uploads a tarball of /shipbash/runtime, /shipbash/dist and the few packages
 * they import (scripts/build-runtime-bundle.mjs) and points production at it
 * with the RUNNER_RUNTIME_VERSION and RUNNER_RUNTIME_URL variables. Every
 * Sandbox that runs runner code installs it once, under
 * /shipbash/release/<version>, right after it is created from the image: a
 * task Sandbox at acquire, and the sign-in Sandboxes (a hand-held sign-in, a
 * takeover) when they open. The image only carries the system
 * layer (browser, Node, the pi SDK) and the code a Sandbox boots with before
 * any install.
 *
 * Everything here goes through one Sandbox command, so any Sandbox handle
 * with `runCommand` can install: no file API, no second interface.
 */
import type { Sandbox } from "@vercel/sandbox";

import { ACTIVITY_TEMPLATE_VERSION } from "@shipbash/contracts/runtime/production-prompts.mjs";

import { shipbashEnvironmentName, shipbashEnvironmentValue } from "../environment.ts";

export interface RuntimeBundle {
  version: string;
  url: string;
  /**
   * The private Blob store's read token; absent for a public URL. It never
   * enters a Sandbox: the firewall adds it to the bundle's download
   * (vercel-sandbox-network-policy.ts).
   */
  token: string | null;
}

/** What an install needs of a Sandbox: a command it can wait for. */
export interface RuntimeInstallTarget {
  runCommand(params: Parameters<Sandbox["runCommand"]>[0]): Promise<{
    exitCode: number | null;
    stderr?(): Promise<string>;
  }>;
}

/** The image's own copy, the code a Sandbox runs before any install. */
const IMAGE_RUNTIME_DIRECTORY = "/shipbash/runtime";
/**
 * Root's, like the image's own code: root runs a release, so the agent's uid
 * may read and run it but never change it. /shipbash/control is the agent's
 * state, never code.
 */
const RUNTIME_HOME = "/shipbash/release";
const INSTALLED_MARKER = ".installed";
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function resolveRuntimeBundle(environment: NodeJS.ProcessEnv): RuntimeBundle | null {
  const version = shipbashEnvironmentValue(environment, "RUNNER_RUNTIME_VERSION")?.trim();
  const url = shipbashEnvironmentValue(environment, "RUNNER_RUNTIME_URL")?.trim();
  if (!version && !url) return null;
  if (!version || !VERSION_PATTERN.test(version)) {
    throw new Error(`${shipbashEnvironmentName("RUNNER_RUNTIME_VERSION")} must be a short version label.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    throw new Error(`${shipbashEnvironmentName("RUNNER_RUNTIME_URL")} must be a valid HTTPS URL.`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${shipbashEnvironmentName("RUNNER_RUNTIME_URL")} must be a credential-free HTTPS URL.`);
  }
  return { version, url: parsed.toString(), token: environment.BLOB_READ_WRITE_TOKEN?.trim() || null };
}

export function runtimeRoot(bundle: RuntimeBundle): string {
  return `${RUNTIME_HOME}/${bundle.version}`;
}

/** Where the installed release's runtime scripts live. */
export function runtimeDirectory(bundle: RuntimeBundle): string {
  return `${runtimeRoot(bundle)}/runtime`;
}

/** What a launch adds so the wrapper, the executor and the runners all run the installed code. */
export function runtimeLaunch(bundle: RuntimeBundle): { script: string; cwd: string; env: Record<string, string> } {
  const root = runtimeRoot(bundle);
  return {
    script: `${root}/runtime/vercel-dispatch-runner.mjs`,
    cwd: `${root}/runtime`,
    env: {
      SHIPBASH_RUNTIME_DIRECTORY: `${root}/runtime`,
      SHIPBASH_DISPATCH_EXECUTOR: `${root}/dist/vercel-sandbox-task.js`,
      [shipbashEnvironmentName("RUNNER_RUNTIME_VERSION")]: bundle.version,
      [shipbashEnvironmentName("EXPECTED_ACTIVITY_TEMPLATE_VERSION")]: ACTIVITY_TEMPLATE_VERSION,
    },
  };
}

/** True when this Sandbox finished installing the release. */
export async function installedRuntime(sandbox: RuntimeInstallTarget, bundle: RuntimeBundle): Promise<boolean> {
  const command = await sandbox.runCommand({
    cmd: "test",
    args: ["-f", `${runtimeRoot(bundle)}/${INSTALLED_MARKER}`],
  });
  return command.exitCode === 0;
}

/**
 * Downloads and unpacks the bundle into the Sandbox and marks it complete.
 * The tarball's top-level directory is the version, so the unpack lands at
 * runtimeRoot(); a re-run over a partial install overwrites it, and the
 * marker is written only after the unpack succeeded. The files are root's,
 * whatever owner and mode the tarball recorded.
 */
export async function installRuntime(sandbox: RuntimeInstallTarget, bundle: RuntimeBundle): Promise<void> {
  const script = [
    "set -eu",
    `mkdir -p "$1"`,
    `curl -fsSL --retry 3 "$2" | tar -xz --no-same-owner --no-same-permissions -C "$1"`,
    `touch "$1/$3/${INSTALLED_MARKER}"`,
  ].join("; ");
  const command = await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", script, "sh", RUNTIME_HOME, bundle.url, bundle.version],
  });
  if (command.exitCode !== 0) {
    // The download's own words, minus the URL that names the store: it has
    // no place in a log line.
    const stderr = (await command.stderr?.() ?? "")
      .replace(/https?:\/\/\S+/gu, "[url]")
      .trim()
      .slice(-400);
    throw new Error(`Runner runtime ${bundle.version} could not be installed (exit ${String(command.exitCode)}): ${stderr}`);
  }
}

/** The runtime directory this Sandbox should run: the release's, installed if it was not, or the image's without a release. */
export async function ensureRuntime(sandbox: RuntimeInstallTarget, bundle: RuntimeBundle | null): Promise<string> {
  if (!bundle) return IMAGE_RUNTIME_DIRECTORY;
  if (!(await installedRuntime(sandbox, bundle))) await installRuntime(sandbox, bundle);
  return runtimeDirectory(bundle);
}
