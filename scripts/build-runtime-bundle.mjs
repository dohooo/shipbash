// The runner's code layer as one tarball: what the Dockerfile puts under
// /shipbash/runtime, /shipbash/dist and the packages they import, plus a
// manifest naming the release and the prompt contract it was built with.
// Run after `bun run build:packages`; release.yml uploads the result.
//
//   node scripts/build-runtime-bundle.mjs <version> <out.tar.gz>
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ACTIVITY_TEMPLATE_VERSION } from "../packages/contracts/src/runtime/production-prompts.mjs";

import { bundleForNode } from "./bundle-for-node.mjs";

const [version, output] = process.argv.slice(2);
if (!version || !output || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(version)) {
  console.error("Usage: node scripts/build-runtime-bundle.mjs <version> <out.tar.gz>");
  process.exit(2);
}

const root = process.cwd();
const staging = mkdtempSync(join(tmpdir(), "shipbash-runtime-"));
const bundle = join(staging, version);
const copy = (from, to) => cpSync(join(root, from), join(bundle, to), { recursive: true, dereference: true });

// /shipbash/runtime: the runner sources and the schemas they read beside them.
copy("packages/runner/src/runtime", "runtime");
for (const schema of ["activity-output", "case-output", "code-evidence-output"]) {
  copy(`packages/contracts/src/runtime/${schema}.schema.json`, `runtime/${schema}.schema.json`);
}

// /shipbash/dist: the one-shot task executor, bundled the way the Dockerfile bundles it.
mkdirSync(join(bundle, "dist"), { recursive: true });
bundleForNode("packages/control-plane/dist/vercel-sandbox-task.js", join(bundle, "dist", "vercel-sandbox-task.js"), root);

// The packages the runtime imports by name, and the ones those need:
// secretlint's (terminal-text-masking.mjs), and @wterm/core — the terminal
// lane's screen (terminal-screen.mjs) and what the terminal page's @wterm/dom
// pins. The pi SDK stays in the image.
copy("packages/contracts/package.json", "node_modules/@shipbash/contracts/package.json");
copy("packages/contracts/dist", "node_modules/@shipbash/contracts/dist");
const SECRETLINT = [
  "@secretlint/core", "@secretlint/profiler", "@secretlint/types", "@secretlint/secretlint-rule-preset-recommend",
  "structured-source", "boundary", "debug", "ms",
];
for (const name of ["zod", "ws", "tldts", "@wterm/dom", "@wterm/core", ...SECRETLINT]) copy(`node_modules/${name}`, `node_modules/${name}`);

writeFileSync(join(bundle, "manifest.json"), `${JSON.stringify({
  version,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  builtAt: new Date().toISOString(),
  activityTemplateVersion: ACTIVITY_TEMPLATE_VERSION,
  runnerVersion: JSON.parse(readFileSync(join(root, "packages/runner/package.json"), "utf8")).version,
}, null, 2)}\n`);

execFileSync("tar", ["-czf", resolve(output), "-C", staging, version], { stdio: "inherit" });
rmSync(staging, { recursive: true, force: true });
console.log(`${output}: runtime ${version}, prompt contract ${ACTIVITY_TEMPLATE_VERSION}`);
