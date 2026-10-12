import { positiveInteger, requiredString } from "@shipbash/contracts/runtime/contract-values.mjs";

import { agentServiceEnvArgs, codexConfigMountArgs } from "../runner-agent-services.ts";
import { checkedAbsolutePath, validateIdentifier } from "./validate.ts";

export const SHIPBASH_MANAGED_LABEL = "io.shipbash.runner.managed";
export const SHIPBASH_PROJECT_HASH_LABEL = "io.shipbash.runner.project-hash";
export const SHIPBASH_SUITE_RUN_ID_LABEL = "io.shipbash.runner.suite-run-id";
/** What a ShipBash container is for (sign-in takeover, sign-in verify). */
export const SHIPBASH_CONTAINER_ROLE_LABEL = "io.shipbash.runner.role";

export interface DockerRunArgOptions {
  image: string;
  containerName: string;
  suiteRunId: string;
  projectHash: string;
  cidFile: string;
  inputDirectory: string;
  outputDirectory: string;
  controlDirectory: string;
  authDirectory: string;
  trustedAccessDirectory?: string | undefined;
  includeEncryptionKey?: boolean | undefined;
  uid?: number | undefined;
  gid?: number | undefined;
  memoryLimit?: string | null | undefined;
}

function bindMount(source: string, destination: string, readOnly = false): string {
  return `type=bind,src=${source},dst=${destination}${readOnly ? ",readonly" : ""}`;
}

const MEMORY_LIMIT_PATTERN = /^[1-9]\d*[bkmg]?$/i;
export const DEFAULT_RUNNER_MEMORY_LIMIT = "4g";

/**
 * A Runner container without a memory bound can exhaust the Docker VM and get
 * the whole execution chain OOM-killed, so a default limit always applies.
 * Set SHIPBASH_RUNNER_MEMORY to override it, or to 0/off to remove the bound.
 */
export function resolveRunnerMemoryLimit(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.SHIPBASH_RUNNER_MEMORY?.trim();
  if (!raw) return DEFAULT_RUNNER_MEMORY_LIMIT;
  if (raw === "0" || raw.toLowerCase() === "off") return null;
  if (!MEMORY_LIMIT_PATTERN.test(raw)) {
    throw new Error("SHIPBASH_RUNNER_MEMORY must be a Docker memory size such as 2048m or 4g, or 0 to disable the limit.");
  }
  return raw;
}

/**
 * Who a Runner container runs as: the host's own user, so what it writes to a
 * bind mount stays the caller's, or a fixed unprivileged id where the host has
 * none (or is root). Never root: the image's default user is.
 */
export function resolveRunAsIds(
  options: { uid?: number | undefined; gid?: number | undefined } = {},
): { uid: number; gid: number } {
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  const uid = positiveInteger(
    options.uid ?? (typeof hostUid === "number" && hostUid > 0 ? hostUid : 10_001),
    "uid",
  );
  const gid = positiveInteger(
    options.gid ?? (typeof hostGid === "number" && hostGid > 0 ? hostGid : 10_001),
    "gid",
  );
  return { uid, gid };
}

export function buildDockerRunArgs(options: DockerRunArgOptions): string[] {
  const image = requiredString(options.image, "image", 500);
  const containerName = validateIdentifier(options.containerName, "containerName");
  const suiteRunId = validateIdentifier(options.suiteRunId, "suiteRunId");
  const projectHash = validateIdentifier(options.projectHash, "projectHash");
  const cidFile = checkedAbsolutePath(options.cidFile, "cidFile");
  const inputDirectory = checkedAbsolutePath(options.inputDirectory, "inputDirectory");
  const outputDirectory = checkedAbsolutePath(options.outputDirectory, "outputDirectory");
  const controlDirectory = checkedAbsolutePath(options.controlDirectory, "controlDirectory");
  const authDirectory = checkedAbsolutePath(options.authDirectory, "authDirectory");
  const { uid, gid } = resolveRunAsIds(options);
  const memoryLimit = options.memoryLimit ?? null;
  if (memoryLimit !== null && !MEMORY_LIMIT_PATTERN.test(memoryLimit)) {
    throw new Error("memoryLimit must be a Docker memory size such as 2048m or 4g.");
  }

  return [
    "run",
    "--init",
    "--rm",
    "--cidfile",
    cidFile,
    "--name",
    containerName,
    "--label",
    `${SHIPBASH_MANAGED_LABEL}=true`,
    "--label",
    `${SHIPBASH_PROJECT_HASH_LABEL}=${projectHash}`,
    "--label",
    `${SHIPBASH_SUITE_RUN_ID_LABEL}=${suiteRunId}`,
    "--user",
    `${uid}:${gid}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    ...(memoryLimit ? ["--memory", memoryLimit, "--memory-swap", memoryLimit] : []),
    "--add-host",
    "host.docker.internal:host-gateway",
    // Remote feature rollouts must never change agent runtime behavior:
    // black-hole the flag CDN so the agent CLI always runs on its defaults.
    "--add-host",
    "cdn.growthbook.io:127.0.0.1",
    "--mount",
    bindMount(inputDirectory, "/shipbash/input", true),
    "--mount",
    bindMount(outputDirectory, "/shipbash/output"),
    "--mount",
    bindMount(controlDirectory, "/shipbash/control"),
    "--mount",
    bindMount(authDirectory, "/shipbash/control/auth"),
    ...codexConfigMountArgs(inputDirectory),
    ...(options.trustedAccessDirectory
      ? [
          "--mount",
          bindMount(
            checkedAbsolutePath(options.trustedAccessDirectory, "trustedAccessDirectory"),
            "/shipbash/trusted-access",
            true,
          ),
        ]
      : []),
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,mode=1777,size=1g",
    "--tmpfs",
    `/shipbash/home:rw,exec,nosuid,nodev,mode=0700,uid=${uid},gid=${gid}`,
    "--tmpfs",
    `/shipbash/work:rw,exec,nosuid,nodev,mode=0700,uid=${uid},gid=${gid}`,
    "--tmpfs",
    `/run/agent-browser:rw,nosuid,nodev,mode=0700,uid=${uid},gid=${gid}`,
    "--publish",
    "127.0.0.1::9224/tcp",
    "--env",
    "HOME=/shipbash/home",
    "--env",
    "AGENT_BROWSER_SOCKET_DIR=/run/agent-browser",
    "--env",
    "SHIPBASH_AUTH_TAKEOVER_TIMEOUT_MS",
    "--env",
    "SHIPBASH_CHROME_TRACE",
    ...agentServiceEnvArgs(),
    ...(options.includeEncryptionKey
      ? ["--env", "AGENT_BROWSER_ENCRYPTION_KEY"]
      : []),
    "--entrypoint",
    "node",
    image,
    "/shipbash/runtime/suite-runner.mjs",
  ];
}
