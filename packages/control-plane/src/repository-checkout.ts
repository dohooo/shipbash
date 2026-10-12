import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertSafeGitHubRepositoryCoordinates, githubCloneUrl } from "./github-app/identifiers.ts";
import type { EphemeralGitHubInstallationToken } from "./github-app/token.ts";

const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const MAX_GIT_STDOUT_BYTES = 8 * 1024;
const ASKPASS_SOURCE = `#!/bin/sh
case "$1" in
  *sername*) printf '%s' 'x-access-token' ;;
  *) printf '%s' "\${SHIPBASH_GITHUB_TOKEN:-}" ;;
esac
`;

export interface GitCommandOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
}

export interface GitCommandResult {
  stdout: string;
}

export interface GitCommandRunner {
  run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult>;
}

class SpawnGitCommandRunner implements GitCommandRunner {
  readonly #binary: string;

  constructor(binary: string) {
    this.#binary = binary;
  }

  run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#binary, [...args], {
        cwd: options.cwd,
        env: options.environment,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = Buffer.alloc(0);
      let outputExceededLimit = false;
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.byteLength > MAX_GIT_STDOUT_BYTES) {
          outputExceededLimit = true;
          child.kill("SIGKILL");
        }
      });
      child.once("error", () => reject(new Error("Git command failed.")));
      child.once("close", (code) => {
        if (code !== 0 || outputExceededLimit) {
          reject(new Error("Git command failed."));
          return;
        }
        resolve({ stdout: stdout.toString("utf8") });
      });
    });
  }
}

export interface CheckoutGitHubRepositoryOptions {
  repository: { owner: string; name: string };
  commitSha: string;
  token: EphemeralGitHubInstallationToken;
  temporaryRoot?: string;
  gitBinary?: string;
  commandRunner?: GitCommandRunner;
  baseEnvironment?: NodeJS.ProcessEnv;
}

export interface CheckedOutGitHubRepository {
  directory: string;
  commitSha: string;
  cleanup(): Promise<void>;
}

function checkoutEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...base };
  for (const name of Object.keys(environment)) {
    if (
      name.startsWith("GIT_") ||
      name === "GH_TOKEN" ||
      name === "GITHUB_TOKEN" ||
      name === "SHIPBASH_GITHUB_TOKEN" ||
      name === "SSH_ASKPASS"
    ) {
      delete environment[name];
    }
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_LFS_SKIP_SMUDGE = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

export async function checkoutGitHubRepository(
  options: CheckoutGitHubRepositoryOptions,
): Promise<CheckedOutGitHubRepository> {
  assertSafeGitHubRepositoryCoordinates(options.repository.owner, options.repository.name);
  const commitSha = options.commitSha.toLowerCase();
  if (!COMMIT_PATTERN.test(commitSha)) {
    throw new Error("The GitHub commit SHA is invalid.");
  }

  const temporaryRoot = options.temporaryRoot ?? tmpdir();
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const workspace = await mkdtemp(join(temporaryRoot, "shipbash-repository-"));
  const repositoryDirectory = join(workspace, "repository");
  const templateDirectory = join(workspace, "empty-git-template");
  const askpassPath = join(workspace, "git-askpass.mjs");

  try {
    await chmod(workspace, 0o700);
    await mkdir(repositoryDirectory, { mode: 0o700 });
    await mkdir(templateDirectory, { mode: 0o700 });
    const runner = options.commandRunner ?? new SpawnGitCommandRunner(options.gitBinary ?? "git");
    const environment = checkoutEnvironment(options.baseEnvironment ?? process.env);
    const cloneUrl = githubCloneUrl(options.repository.owner, options.repository.name);

    await runner.run(["init", "--quiet", `--template=${templateDirectory}`, "."], {
      cwd: repositoryDirectory,
      environment,
    });
    await rm(templateDirectory, { recursive: true, force: true });
    await runner.run(["remote", "add", "origin", cloneUrl], {
      cwd: repositoryDirectory,
      environment,
    });

    await writeFile(askpassPath, ASKPASS_SOURCE, { encoding: "utf8", mode: 0o700 });
    await chmod(askpassPath, 0o700);
    await options.token.use(async (token) => {
      const authenticatedEnvironment = {
        ...environment,
        GIT_ASKPASS: askpassPath,
        GIT_TERMINAL_PROMPT: "0",
        SHIPBASH_GITHUB_TOKEN: token,
      };
      await runner.run(
        ["fetch", "--quiet", "--no-tags", "--depth=1", "origin", commitSha],
        { cwd: repositoryDirectory, environment: authenticatedEnvironment },
      );
    });
    await rm(askpassPath, { force: true });

    await runner.run(["checkout", "--quiet", "--detach", "FETCH_HEAD"], {
      cwd: repositoryDirectory,
      environment,
    });
    const revision = await runner.run(["rev-parse", "HEAD"], {
      cwd: repositoryDirectory,
      environment,
    });
    if (revision.stdout.trim().toLowerCase() !== commitSha) {
      throw new Error("Checked out commit did not match the requested commit.");
    }

    let cleaned = false;
    return {
      directory: repositoryDirectory,
      commitSha,
      async cleanup() {
        if (cleaned) return;
        await rm(workspace, { recursive: true, force: true });
        cleaned = true;
      },
    };
  } catch {
    await rm(workspace, { recursive: true, force: true });
    throw new Error("GitHub repository checkout failed.");
  }
}
