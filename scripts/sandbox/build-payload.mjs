// The Sandbox smoke's payload directory (.github/actions/runtime-bundle): the
// runtime bundle exactly as a release builds it, the browser and replay
// probes, and the smoke's runner (scripts/sandbox-browser-smoke.ts) bundled into one file,
// so the job that runs it installs nothing. Run after the bundle is built.
//
//   node scripts/sandbox/build-payload.mjs <runtime-bundle.tar.gz> <out dir>
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { bundleForNode } from "../bundle-for-node.mjs";

const [bundle, out] = process.argv.slice(2);
if (!bundle || !out) {
  console.error("Usage: node scripts/sandbox/build-payload.mjs <runtime-bundle.tar.gz> <out dir>");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
copyFileSync(bundle, join(out, "runtime-bundle.tar.gz"));
for (const probe of ["browser-probe.mjs", "replay-probe.mjs"]) copyFileSync(`scripts/sandbox/${probe}`, join(out, probe));
bundleForNode("scripts/sandbox-browser-smoke.ts", join(out, "sandbox-browser-smoke.mjs"));
