import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RUNNER_IMAGE } from "./runner-image.ts";
import { runnerBuildInputPaths } from "./runner-build-inputs.ts";
import { toolProcessEnvironment } from "./tool-environment.ts";

const RUNNER_BUILD_DIGEST_LABEL = "io.shipbash.runner.build-digest";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CommandOptions {
  cwd?: string;
}

export function run(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
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
    child.once("close", (exitCode) => {
      resolvePromise({ exitCode: exitCode ?? 1, stdout, stderr });
    });
    child.stdin.end();
  });
}

function packageRoot(): string {
  return fileURLToPath(new URL("../../../", import.meta.url));
}

export async function runnerBuildDigest(root: string): Promise<string> {
  const paths = (await runnerBuildInputPaths(root)).map((path) => join(root, path));
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path.slice(root.length));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function expectedRunnerBuildDigest(): Promise<string> {
  return runnerBuildDigest(packageRoot());
}

export interface RunnerImageIdentity {
  imageId: string;
  buildDigest: string;
}

export async function inspectRunnerImageIdentity(
  dockerBinary: string,
  image: string,
): Promise<RunnerImageIdentity> {
  const [id, digest] = await Promise.all([
    imageId(dockerBinary, image),
    run(dockerBinary, [
      "image",
      "inspect",
      "--format",
      `{{index .Config.Labels "${RUNNER_BUILD_DIGEST_LABEL}"}}`,
      image,
    ]),
  ]);
  const buildDigest = digest.stdout.trim();
  if (digest.exitCode !== 0 || !/^[a-f0-9]{64}$/u.test(buildDigest)) {
    throw new Error(
      `Docker runtime image build identity is unavailable: ${digest.stderr.trim() || digest.stdout.trim()}`,
    );
  }
  return { imageId: id, buildDigest };
}

export async function ensureRunnerImage(
  dockerBinary = process.env.SHIPBASH_DOCKER_BINARY ?? "docker",
): Promise<void> {
  const root = packageRoot();
  const expectedBuildDigest = await runnerBuildDigest(root);
  const inspected = await run(dockerBinary, [
    "image",
    "inspect",
    "--format",
    `{{index .Config.Labels "${RUNNER_BUILD_DIGEST_LABEL}"}}`,
    RUNNER_IMAGE,
  ]);
  if (inspected.exitCode === 0 && inspected.stdout.trim() === expectedBuildDigest) return;
  const dockerfile = join(root, "packages", "runner", "Dockerfile");
  const built = await run(
    dockerBinary,
    [
      "build",
      "--build-arg",
      `SHIPBASH_RUNNER_BUILD_DIGEST=${expectedBuildDigest}`,
      "--file",
      dockerfile,
      "--tag",
      RUNNER_IMAGE,
      root,
    ],
    { cwd: root },
  );
  if (built.exitCode !== 0) {
    throw new Error(`Docker runtime image build failed: ${built.stderr.trim() || built.stdout.trim()}`);
  }
}

async function imageId(dockerBinary: string, image = RUNNER_IMAGE): Promise<string> {
  const inspected = await run(dockerBinary, [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    image,
  ]);
  const id = inspected.stdout.trim();
  if (inspected.exitCode !== 0 || id.length === 0) {
    throw new Error(
      `Docker runtime image could not be inspected: ${inspected.stderr.trim() || inspected.stdout.trim()}`,
    );
  }
  return id;
}
