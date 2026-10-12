// The one command that runs the pre-push gate. Every step below is one CI
// enforces; each is checked by its real exit code and the first failure stops
// the run, so nothing passes by being skipped or by having its status swallowed.
// `bun run gate:prepush` runs it under the machine-wide heavy lock (scripts/heavy-lock.sh) for the
// whole gate. It measures the branch against origin/main, the branch every pull request merges into:
// gate, then `git push` (with --force-with-lease after a rebase), then open a pull request to main.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";

import { piPackages } from "./pi-packages.ts";

const ROOT = process.cwd();
const MANIFESTS = ["package.json", "bun.lock"];
// One real entry per package, taken from its exports map: a build that leaves
// any of these missing sends the console into "Module not found" and blames
// the wrong step.
const DIST_ENTRIES = [
  ["contracts", "packages/contracts/dist/activity-lifecycle.js"],
  ["control-plane", "packages/control-plane/dist/environment.js"],
  ["runner", "packages/runner/dist/runtime/assets.mjs"],
] as const;
const completed: string[] = [];

function fail(step: string, detail: string): never {
  console.error(`\ngate:prepush FAILED at "${step}": ${detail}`);
  process.exit(1);
}

function run(name: string, command: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  console.log(`\n=== gate:prepush ${name} ===`);
  const result = spawnSync(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" });
  if (result.error) fail(name, result.error.message);
  if (result.status !== 0) fail(name, `${command} exited with ${result.status ?? "a signal"}`);
  completed.push(name);
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) fail(`git ${args.join(" ")}`, result.stderr.trim());
  return result.stdout;
}

function dockerfilePiPackages(): string[] {
  try {
    return piPackages(readFileSync("packages/runner/Dockerfile", "utf8"));
  } catch (error) {
    return fail("pi lane", error instanceof Error ? error.message : String(error));
  }
}

// The pi lane, run exactly as .github/workflows/gates.yml runs it. Its
// `bun add --no-save` leaves the manifests as they were, and the gate checks
// that it did: the gate must leave no diff behind.
function piLane(): void {
  const pins = dockerfilePiPackages();
  const dirtyBefore = git(["status", "--porcelain", ...MANIFESTS]);
  run("pi lane install", "bun", ["add", "--no-save", "--ignore-scripts", ...pins]);
  const checked = spawnSync("bunx", ["tsc", "-p", "packages/runner/tsconfig.pi.json", "--noEmit"], { cwd: ROOT, stdio: "inherit" });
  if (git(["status", "--porcelain", ...MANIFESTS]) !== dirtyBefore) fail("pi lane", "bun add left the manifests modified");
  if (checked.status !== 0) fail("pi lane checkJs", `tsc exited with ${checked.status ?? "a signal"}`);
  completed.push("pi lane checkJs");
}

run("git fetch origin main", "git", ["fetch", "origin", "main"]);

// A dirty tree means the gate is testing something other than what would be
// pushed — an amend whose changes fell back into the working copy passes every
// step below while HEAD is missing them.
const dirty = git(["status", "--porcelain"]).trim();
if (dirty) {
  fail("clean working tree", `working tree is dirty: commit or stash before gating\n${dirty.split("\n").slice(0, 5).join("\n")}`);
}
completed.push("clean working tree");
if (spawnSync("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd: ROOT }).status !== 0) fail("origin/main ancestry", "HEAD does not contain origin/main. Rebase this branch onto origin/main first.");
run("typecheck", "bun", ["run", "typecheck"]);
run("lint", "bun", ["run", "lint"], { BIOME_LINT_BASE: "origin/main", BIOME_LINT_HEAD: "HEAD" });
run("build:web", "bun", ["run", "build:web"]);
for (const [pkg, entry] of DIST_ENTRIES) {
  const size = statSync(entry, { throwIfNoEntry: false })?.size ?? 0;
  if (size === 0) fail("build:web dist check", `build:web produced no dist for ${pkg} (${entry})`);
}
completed.push("build:web dist check");

const runtimeTouched = git(["diff", "--name-only", "origin/main...HEAD"]).split("\n").some((file) => file.startsWith("packages/runner/src/runtime"));
if (runtimeTouched) piLane();
else completed.push("pi lane (skipped: no packages/runner/src/runtime changes)");

const baseline = z.object({ entries: z.array(z.unknown()) }).parse(JSON.parse(readFileSync("config/lint-discipline-baseline.json", "utf8")));
console.log(`\ndiscipline baseline: ${baseline.entries.length} entries.`);
console.log(`all gates green: ${completed.join(", ")}.`);
