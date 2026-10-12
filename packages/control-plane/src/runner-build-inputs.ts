import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

// Files outside workspace source trees that influence the image build. Source
// trees are walked recursively below so adding a new module can never leave a
// locally cached Runner image stale.
export const RUNNER_BUILD_INPUTS = [
  ".dockerignore",
  "packages/runner/Dockerfile",
  "packages/runner/scripts/patch-novnc-first-frame.mjs",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.base.json",
  "packages/control-plane/package.json",
  "packages/control-plane/tsconfig.json",
  "packages/contracts/package.json",
  "packages/contracts/tsconfig.json",
  "packages/runner/package.json",
] as const;

const RECURSIVE_RUNNER_BUILD_DIRECTORIES = [
  ["packages", "control-plane", "src"],
  ["packages", "contracts", "src"],
  ["packages", "runner", "src", "runtime"],
] as const;

export async function runnerBuildInputPaths(root: string): Promise<string[]> {
  const recursiveInputs = (await Promise.all(
    RECURSIVE_RUNNER_BUILD_DIRECTORIES.map(async (segments) => {
      const directory = join(root, ...segments);
      return (await readdir(directory, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => relative(root, join(entry.parentPath, entry.name)));
    }),
  )).flat().sort();

  return [...RUNNER_BUILD_INPUTS, ...recursiveInputs];
}
