/**
 * Runs a sign-in check with the same container hardening as preauthorization.
 * All checks attach to the project's
 * existing browser through its container network, retaining the current page.
 * The leg's config arrives through a one-shot read-only mount, never Docker
 * argv; a password leg reads its credential from the host's credential broker,
 * named on the writable control mount beside the consumed marker and the
 * captured session.
 */
import { createHash } from "node:crypto";

import { type SignInLegMode, signInLegEnvironment } from "@shipbash/runner/runtime/sign-in-leg.mjs";

import {
  SHIPBASH_CONTAINER_ROLE_LABEL,
  SHIPBASH_MANAGED_LABEL,
  SHIPBASH_PROJECT_HASH_LABEL,
} from "./docker-runtime.ts";
import { run } from "./init-browser-image.ts";
import { agentServiceEnvArgs } from "./runner-agent-services.ts";

export const SIGN_IN_VERIFY_CONTAINER_ROLE = "sign-in-verify";

/** Deterministic, so a container stranded by a crashed service is found again by name. */
export function signInVerifyContainerName(signInId: string): string {
  return `shipbash-verify-${createHash("sha256").update(signInId).digest("hex").slice(0, 12)}`;
}

export interface SignInVerifyContainerArgsInput {
  browserContainerId: string;
  name: string;
  image: string;
  mode: SignInLegMode;
  projectHash: string;
  /** Host directory bound at /shipbash/control; the runner writes its release marker here. */
  controlDirectory: string;
  /** Host directory bound READ-ONLY at /shipbash/sign-in; holds the one-shot config. */
  sessionDirectory: string;
  uid: number;
  gid: number;
}

export function signInVerifyContainerArgs(input: SignInVerifyContainerArgsInput): string[] {
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
    `${SHIPBASH_CONTAINER_ROLE_LABEL}=${SIGN_IN_VERIFY_CONTAINER_ROLE}`,
    "--user",
    `${String(uid)}:${String(gid)}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    `type=bind,src=${input.controlDirectory},dst=/shipbash/control`,
    "--mount",
    `type=bind,src=${input.sessionDirectory},dst=/shipbash/sign-in,readonly`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,mode=1777,size=1g",
    "--tmpfs",
    `/shipbash/home:rw,nosuid,nodev,mode=0700,uid=${String(uid)},gid=${String(gid)}`,
    "--tmpfs",
    `/shipbash/work:rw,nosuid,nodev,mode=0700,uid=${String(uid)},gid=${String(gid)}`,
    "--tmpfs",
    `/run/agent-browser:rw,nosuid,nodev,mode=0700,uid=${String(uid)},gid=${String(gid)}`,
    "--network", `container:${input.browserContainerId}`,
    ...Object.entries(signInLegEnvironment({ mode: input.mode, projectHash: input.projectHash }))
      .flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    // A password check signs in with the agent (sign-in-agent.mjs); Jev
    // judges the page the check settles on (sign-in-verdict.mjs).
    ...agentServiceEnvArgs(),
    "--entrypoint",
    "node",
    input.image,
    "/shipbash/runtime/suite-runner.mjs",
    input.mode,
  ];
}

export interface SignInVerifyContainerInput {
  browserContainerId: string;
  dockerBinary: string;
  image: string;
  mode: SignInLegMode;
  signInId: string;
  projectHash: string;
  controlDirectory: string;
  sessionDirectory: string;
}

/** Starts the checker. Any checker container of the same name is removed first. */
export async function startSignInVerifyContainer(
  input: SignInVerifyContainerInput,
): Promise<{ name: string }> {
  const name = signInVerifyContainerName(input.signInId);
  await run(input.dockerBinary, ["rm", "--force", name]);
  const created = await run(
    input.dockerBinary,
    signInVerifyContainerArgs({
      name,
      image: input.image,
      mode: input.mode,
      browserContainerId: input.browserContainerId,
      projectHash: input.projectHash,
      controlDirectory: input.controlDirectory,
      sessionDirectory: input.sessionDirectory,
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    }),
  );
  if (created.exitCode !== 0) {
    throw new Error(`The sign-in browser failed to start: ${created.stderr.trim()}`);
  }
  return { name };
}

export async function readSignInVerifyLog(dockerBinary: string, name: string): Promise<string> {
  const logs = await run(dockerBinary, ["logs", "--tail", "400", name]);
  return `${logs.stdout}\n${logs.stderr}`;
}

export async function stopSignInVerifyContainer(dockerBinary: string, name: string): Promise<void> {
  await run(dockerBinary, ["rm", "--force", name]);
}
