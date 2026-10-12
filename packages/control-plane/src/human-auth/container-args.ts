/**
 * The `docker run` argv for one takeover container: read-only root, no added
 * capabilities, a Chromium-specific seccomp profile, tmpfs for every path the
 * viewer writes to, and the loopback-only viewer port. The target URL and the
 * viewer password travel as named environment variables, never as arguments.
 */
import { chromiumAuthSeccompProfilePath } from "@shipbash/runner/runtime/assets.mjs";

import { agentServiceEnvArgs } from "../runner-agent-services.ts";
import { type TrustedAccessRuntimePaths, trustedAccessMountArgs } from "./trusted-access.ts";

const MANAGED_LABEL = "shipbash.managed";
const PROJECT_HASH_LABEL = "shipbash.projectHash";
const AUTH_SESSION_HASH_LABEL = "shipbash.authSessionHash";

/** Named on the argv and read from the environment; the value never appears in either place. */
export const HUMAN_AUTH_PASSWORD_ENV = "SHIPBASH_HUMAN_AUTH_PASSWORD";

export function humanAuthContainerArgs(input: {
  containerName: string;
  projectHash: string;
  sessionHash: string;
  uid: number;
  gid: number;
  image: string;
  authDirectory: string;
  trustedAccessRuntime: TrustedAccessRuntimePaths | null;
}): string[] {
  const {
    authDirectory,
    containerName,
    gid,
    image,
    projectHash,
    sessionHash,
    trustedAccessRuntime,
    uid,
  } = input;
  return [
    "run",
    "--detach",
    "--init",
    "--rm",
    "--name",
    containerName,
    "--label",
    `${MANAGED_LABEL}=true`,
    "--label",
    `${PROJECT_HASH_LABEL}=${projectHash}`,
    "--label",
    `${AUTH_SESSION_HASH_LABEL}=${sessionHash}`,
    "--user",
    `${uid}:${gid}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--security-opt",
    `seccomp=${chromiumAuthSeccompProfilePath()}`,
    ...trustedAccessMountArgs(trustedAccessRuntime),
    "--mount",
    `type=bind,src=${authDirectory},dst=/shipbash/control/auth`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,mode=1777,size=1g",
    "--tmpfs",
    `/shipbash/home:rw,nosuid,nodev,mode=0700,uid=${uid},gid=${gid}`,
    // The human-auth entry builds its throwaway browser profile under
    // /shipbash/work; without a writable mount there the container dies on
    // boot and every suite takeover reads "Connecting to browser…" forever.
    "--tmpfs",
    `/shipbash/work:rw,nosuid,nodev,mode=0700,uid=${uid},gid=${gid}`,
    "--tmpfs",
    `/run/agent-browser:rw,nosuid,nodev,mode=0700,uid=${uid},gid=${gid}`,
    "--publish",
    "127.0.0.1::6080/tcp",
    "--env",
    "SHIPBASH_HUMAN_AUTH_URL",
    "--env",
    HUMAN_AUTH_PASSWORD_ENV,
    // Jev judges the product page the capture seals by (human-auth-page.mjs).
    ...agentServiceEnvArgs(),
    image,
    "human-auth",
  ];
}
