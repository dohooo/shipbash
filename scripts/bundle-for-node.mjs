// One script bundled into one file for node, as the runner's Sandbox runs
// them: ESM, every import inlined, and a require() for the CommonJS inside.
// build-runtime-bundle.mjs bundles the task executor with it, and
// sandbox/build-payload.mjs the Sandbox smoke's runner.
import { execFileSync } from "node:child_process";

const REQUIRE_BANNER = "import { createRequire as __shipbashCreateRequire } from 'node:module'; const require = __shipbashCreateRequire(import.meta.url);";

/** @param {string} entry @param {string} outfile @param {string} cwd */
export function bundleForNode(entry, outfile, cwd = process.cwd()) {
  execFileSync("bunx", [
    "esbuild", entry,
    "--bundle", "--platform=node", "--format=esm",
    `--outfile=${outfile}`,
    `--banner:js=${REQUIRE_BANNER}`,
  ], { cwd, stdio: "inherit" });
}
