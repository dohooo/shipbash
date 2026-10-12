import { identifier, requiredString } from "@shipbash/contracts/runtime/contract-values.mjs";

import { resolveRunAsIds } from "../docker-runtime.ts";
import { agentServiceEnvArgs, codexConfigMountArgs } from "../runner-agent-services.ts";
import { checkedAbsolutePath } from "./paths.ts";

export const SHIPBASH_MANAGED_LABEL = "io.shipbash.runner.managed";
export const SHIPBASH_PROJECT_HASH_LABEL = "io.shipbash.runner.project-hash";
export const SHIPBASH_ACTIVITY_ID_LABEL = "io.shipbash.runner.activity-id";
export const SHIPBASH_ACTIVITY_KIND_LABEL = "io.shipbash.runner.kind";

export interface ActivityDockerRunArgOptions {
  image: string;
  containerName: string;
  activityId: string;
  projectHash: string;
  cidFile: string;
  inputDirectory: string;
  outputDirectory: string;
  controlDirectory: string;
  authDirectory: string;
  /** Persistent pi session home (its transcript), task-scoped. */
  sessionDirectory?: string | undefined;
  repositoryDirectory: string;
  trustedAccessDirectory?: string | undefined;
  uid?: number | undefined;
  gid?: number | undefined;
  memoryLimit?: string | null | undefined;
}

function bindMount(source: string, destination: string, readOnly = false): string {
  return `type=bind,src=${source},dst=${destination}${readOnly ? ",readonly" : ""}`;
}

export function buildActivityDockerRunArgs(options: ActivityDockerRunArgOptions): string[] {
  const { uid, gid } = resolveRunAsIds(options);
  const activityId = identifier(options.activityId, "activityId");
  const projectHash = identifier(options.projectHash, "projectHash");
  return [
    "run", "--init", "--rm",
    "--cidfile", checkedAbsolutePath(options.cidFile, "cidFile"),
    "--name", identifier(options.containerName, "containerName"),
    "--label", `${SHIPBASH_MANAGED_LABEL}=true`,
    "--label", `${SHIPBASH_PROJECT_HASH_LABEL}=${projectHash}`,
    "--label", `${SHIPBASH_ACTIVITY_KIND_LABEL}=activity`,
    "--label", `${SHIPBASH_ACTIVITY_ID_LABEL}=${activityId}`,
    "--user", `${uid}:${gid}`,
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    ...(options.memoryLimit ? ["--memory", options.memoryLimit, "--memory-swap", options.memoryLimit] : []),
    "--add-host", "host.docker.internal:host-gateway",
    // Remote feature rollouts must never change agent runtime behavior:
    // black-hole the flag CDN so the agent CLI always runs on its defaults.
    "--add-host", "cdn.growthbook.io:127.0.0.1",
    "--mount", bindMount(checkedAbsolutePath(options.inputDirectory, "inputDirectory"), "/shipbash/input", true),
    "--mount", bindMount(checkedAbsolutePath(options.outputDirectory, "outputDirectory"), "/shipbash/output"),
    "--mount", bindMount(checkedAbsolutePath(options.controlDirectory, "controlDirectory"), "/shipbash/control"),
    // The real path, never the /shipbash/auth symlink: the symlink resolves to
    // /shipbash/control/auth, i.e. INSIDE the control bind, and Docker gives no
    // ordering guarantee between same-depth destinations — the control bind
    // intermittently covered the auth bind, so a resumed leg booted without
    // the sign-in a takeover had just captured.
    // One level deeper sorts strictly after /shipbash/control; the runner keeps
    // reading /shipbash/auth through the image symlink.
    "--mount", bindMount(checkedAbsolutePath(options.authDirectory, "authDirectory"), "/shipbash/control/auth"),
    "--mount", bindMount(checkedAbsolutePath(options.repositoryDirectory, "repositoryDirectory"), "/shipbash/repository", true),
    ...codexConfigMountArgs(checkedAbsolutePath(options.inputDirectory, "inputDirectory")),
    ...(options.sessionDirectory
      ? ["--mount", bindMount(checkedAbsolutePath(options.sessionDirectory, "sessionDirectory"), "/shipbash/control/pi-session")]
      : []),
    ...(options.trustedAccessDirectory
      ? ["--mount", bindMount(
          checkedAbsolutePath(options.trustedAccessDirectory, "trustedAccessDirectory"),
          "/shipbash/trusted-access",
          true,
        )]
      : []),
    "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777,size=1g",
    // exec is explicit: docker tmpfs defaults to noexec, which silently broke
    // every "install the product's CLI and run it" story — npm's global
    // prefix lives under this HOME precisely so those installs work
    // (a product CLI's `Permission denied`). nosuid/nodev stay.
    "--tmpfs", `/shipbash/home:rw,exec,nosuid,nodev,mode=0700,uid=${uid},gid=${gid}`,
    "--tmpfs", `/shipbash/work:rw,exec,nosuid,nodev,mode=0700,uid=${uid},gid=${gid}`,
    "--tmpfs", `/run/agent-browser:rw,nosuid,nodev,mode=0700,uid=${uid},gid=${gid}`,
    "--publish", "127.0.0.1::9224/tcp",
    "--publish", "127.0.0.1::6080/tcp",
    "--env", "HOME=/shipbash/home",
    ...agentServiceEnvArgs(),
    "--env", "AGENT_BROWSER_SOCKET_DIR=/run/agent-browser",
    "--env", "AGENT_BROWSER_ENCRYPTION_KEY",
    "--env", "SHIPBASH_HUMAN_AUTH_PASSWORD",
    ...(options.sessionDirectory ? ["--env", "SHIPBASH_PI_SESSION_ROOT=/shipbash/control/pi-session"] : []),
    "--entrypoint", "node",
    requiredString(options.image, "image", 500),
    "/shipbash/runtime/activity-runner.mjs",
  ];
}
