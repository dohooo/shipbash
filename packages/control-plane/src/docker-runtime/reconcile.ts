// Container reconciliation and control: docker invocation capture, the
// managed-container sweep, launch polling, sentinels, and the exit mapping.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isErrno } from "../errno.ts";
import { toolProcessEnvironment } from "../tool-environment.ts";
import {
  SHIPBASH_MANAGED_LABEL,
  SHIPBASH_PROJECT_HASH_LABEL,
} from "./docker-args.ts";
import { redactString } from "./redaction.ts";
import { checkedAbsolutePath, validateIdentifier } from "./validate.ts";

export interface DockerReconcileOptions {
  dockerBinary?: string;
  /** Container names an adopted Runtime Session still depends on. */
  preserveContainerNames?: readonly string[];
}

const CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/i;
const CIDFILE_ID_PATTERN = /^[a-f0-9]{64}$/i;

export function mapContainerExit(
  exitCode: number | null,
  abortRequested: boolean,
  lastEventType?: string,
): "completed" | "canceled" | "failed" {
  if (abortRequested || exitCode === 130 || lastEventType === "suite_canceled") {
    return "canceled";
  }
  return exitCode === 0 ? "completed" : "failed";
}

export async function writeCancelSentinel(controlDirectory: string): Promise<string> {
  const directory = checkedAbsolutePath(controlDirectory, "controlDirectory");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "cancel");
  await writeFile(path, `${new Date().toISOString()}\n`, { mode: 0o600 });
  return path;
}

export function runCapture(
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: toolProcessEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {
      // A failed command may close stdin before the batch payload is written.
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args[0] ?? ""} failed: ${redactString(stderr.trim())}`));
        return;
      }
      resolvePromise({ code, stdout });
    });
    child.stdin.end();
  });
}

export async function reconcileProjectContainers(
  projectHashValue: string,
  options: DockerReconcileOptions = {},
): Promise<string[]> {
  const projectHash = validateIdentifier(projectHashValue, "projectHash");
  const dockerBinary = options.dockerBinary ?? "docker";
  // Names as well as ids: the preserve list is what stops a restart from
  // destroying the container a human is still signing into.
  const preserved = new Set(options.preserveContainerNames ?? []);
  const { stdout } = await runCapture(dockerBinary, [
    "ps",
    "-a",
    "--filter",
    `label=${SHIPBASH_MANAGED_LABEL}=true`,
    "--filter",
    `label=${SHIPBASH_PROJECT_HASH_LABEL}=${projectHash}`,
    "--format",
    "{{.ID}} {{.Names}}",
  ]);
  const containerIds = stdout.split(/\r?\n/).flatMap((line) => {
    const [id, name] = line.trim().split(/\s+/);
    if (id === undefined || !CONTAINER_ID_PATTERN.test(id)) return [];
    if (name !== undefined && preserved.has(name)) return [];
    return [id];
  });
  if (containerIds.length === 0) return [];
  await runCapture(dockerBinary, ["rm", "--force", ...containerIds]);
  return containerIds;
}

export function containerNameForSuite(suiteRunId: string): string {
  const readable = suiteRunId.slice(0, 64);
  const digest = createHash("sha256").update(suiteRunId).digest("hex").slice(0, 16);
  return `shipbash-suite-${readable}-${digest}`;
}

export async function waitForContainerId(cidFile: string): Promise<string> {
  let sawPartialWrite = false;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const containerId = (await readFile(cidFile, "utf8")).trim();
      if (CIDFILE_ID_PATTERN.test(containerId)) return containerId;
      sawPartialWrite = true;
    } catch (error) {
      if (!isErrno(error) || error.code !== "ENOENT") throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  if (sawPartialWrite) throw new Error("Docker did not finish writing a valid runner container id.");
  throw new Error("Docker did not write the runner container id within 10 seconds.");
}

export async function resolvePublishedStreamPort(
  dockerBinary: string,
  containerName: string,
): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const { stdout } = await runCapture(dockerBinary, ["port", containerName, "9224/tcp"]);
      const match = stdout.trim().match(/127\.0\.0\.1:(\d+)$/m);
      if (match) {
        return Number(match[1]);
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(
    `Docker did not report the loopback stream port${lastError ? `: ${String(lastError)}` : "."}`,
  );
}

export async function stopContainer(
  dockerBinary: string,
  containerName: string,
): Promise<void> {
  try {
    await runCapture(dockerBinary, ["stop", "--time", "5", containerName]);
  } catch {
    // The --rm container may already have exited after observing the cancel sentinel.
  }
}
