import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SUPPORTED_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);

const GENERATED_OR_VENDOR_PATHS = [
  "apps/marketing/public/shipbash-brand/",
  "brand/exports/",
  "brand/source/shipbash-eye.svg",
  "apps/console/components/ai-elements/",
  "apps/console/public/shipbash-brand/",
];

function runGit(args: string[]): string[] {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(`git ${args.join(" ")} failed.`);
  }
  return result.stdout.split("\0").filter(Boolean);
}

function revisionExists(revision: string): boolean {
  return spawnSync("git", ["cat-file", "-e", `${revision}^{commit}`], {
    cwd: process.cwd(),
    stdio: "ignore",
  }).status === 0;
}

function fallbackBase(head: string): string {
  const parent = `${head}^`;
  if (revisionExists(parent)) return parent;
  const result = spawnSync("git", ["mktree"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: "",
  });
  if (result.status !== 0) throw new Error("Could not resolve an empty Git tree.");
  return result.stdout.trim();
}

function changedFiles(): string[] {
  const configuredHead = process.env.BIOME_LINT_HEAD?.trim();
  const configuredBase = process.env.BIOME_LINT_BASE?.trim();
  if (configuredHead || configuredBase) {
    const head = configuredHead && revisionExists(configuredHead) ? configuredHead : "HEAD";
    const baseIsUsable = configuredBase
      && !/^0+$/u.test(configuredBase)
      && revisionExists(configuredBase);
    const base = baseIsUsable ? configuredBase : fallbackBase(head);
    return runGit([
      "diff",
      "--no-renames",
      "--name-only",
      "--diff-filter=ACMR",
      "-z",
      base,
      head,
    ]);
  }

  return [
    ...runGit(["diff", "--name-only", "--diff-filter=ACMR", "-z", "HEAD"]),
    ...runGit(["ls-files", "--others", "--exclude-standard", "-z"]),
  ];
}

function isLintable(path: string): boolean {
  if (GENERATED_OR_VENDOR_PATHS.some((excluded) => (
    excluded.endsWith("/") ? path.startsWith(excluded) : path === excluded
  ))) return false;
  const extensionIndex = path.lastIndexOf(".");
  return extensionIndex >= 0 && SUPPORTED_EXTENSIONS.has(path.slice(extensionIndex));
}

const files = [...new Set(changedFiles())].filter(isLintable).sort();
if (files.length === 0) {
  console.log("No changed source files to lint.");
  process.exit(0);
}

console.log(`Linting ${files.length} changed source file${files.length === 1 ? "" : "s"}.`);
const executable = join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "biome.cmd" : "biome",
);
if (!existsSync(executable)) throw new Error("Biome is not installed. Run bun install first.");

const result = spawnSync(executable, ["lint", "--no-errors-on-unmatched", ...files], {
  cwd: process.cwd(),
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
