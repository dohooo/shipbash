// The runner's browser in a real Vercel Sandbox, as production runs it: a
// Sandbox made from the runner image, the runtime bundle installed by
// production's own install (runtime-bundle.ts installRuntime), and the probe
// run as the runner child runs there: uid 10001 (sandbox-agent-command.ts),
// in a task tree laid out as production lays one out (paths.ts), with
// production's child environment (child-environment.ts) over the Sandbox's
// own. The browser probe (scripts/sandbox/browser-probe.mjs) launches the
// browser as every lane launches one and runs one agent-browser command and
// the desktop probe; the replay probe (scripts/sandbox/replay-probe.mjs)
// exports a walk's replay whose shell the console's renderer draws in this
// Chromium, which the image build's own smoke cannot run natively.
//
// The Sandbox is deleted however the run ends. From
// .github/workflows/sandbox-browser-smoke.yml, bundled into the payload
// directory scripts/sandbox/build-payload.mjs stages:
//
//   node <payload>/sandbox-browser-smoke.mjs --image <ref> --payload <payload>
//   (env: VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID)
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { Sandbox } from "@vercel/sandbox";

import { installRuntime, runtimeDirectory, type RuntimeBundle } from "../packages/control-plane/src/vercel-sandbox-dispatch/runtime-bundle.ts";
import { SANDBOX_AGENT_GID, SANDBOX_AGENT_UID, sandboxAgentCommand } from "../packages/control-plane/src/vercel-sandbox-dispatch/sandbox-agent-command.ts";
import { childEnvironment } from "../packages/control-plane/src/vercel-sandbox-runtime/child-environment.ts";
import { runtimeLayout, type RuntimeLayout } from "../packages/control-plane/src/vercel-sandbox-runtime/paths.ts";

const STAGING = "/tmp/sandbox-smoke";
/** Each probe prints one JSON line and passes when that line says `ok`. */
const PROBES = ["browser-probe.mjs", "replay-probe.mjs"] as const;
// The workflow's job timeout allows for both, and for the delete after them.
const IMAGE_READY_DEADLINE_MS = 20 * 60_000;
const SANDBOX_TIMEOUT_MS = 10 * 60_000;

function credentials(): { token: string; teamId: string; projectId: string } {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !teamId || !projectId) throw new Error("VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID are required.");
  return { token, teamId, projectId };
}

/** The bundle's version, as its manifest names it (build-runtime-bundle.mjs), under the one directory the bundle holds. */
function bundleVersion(bundlePath: string): string {
  const listing = execFileSync("tar", ["-tzf", bundlePath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const top = listing.split("\n")[0]?.split("/")[0] ?? "";
  const manifest: unknown = JSON.parse(execFileSync("tar", ["-xzOf", bundlePath, `${top}/manifest.json`], { encoding: "utf8" }));
  const version = typeof manifest === "object" && manifest !== null && "version" in manifest ? manifest.version : null;
  if (typeof version !== "string" || version !== top) throw new Error(`The runtime bundle's manifest does not name its directory ${top}.`);
  return version;
}

/** A Sandbox from the image, waiting out a registry that is still preparing it (409 image_not_ready). */
async function createSandbox(image: string): Promise<Sandbox> {
  const deadline = Date.now() + IMAGE_READY_DEADLINE_MS;
  for (;;) {
    try {
      return await Sandbox.create({
        ...credentials(),
        image,
        name: `shipbash-smoke-${randomBytes(4).toString("hex")}`,
        timeout: SANDBOX_TIMEOUT_MS,
        persistent: false,
        region: "sfo1",
      });
    } catch (error) {
      if (!/image_not_ready|409/u.test(String(error)) || Date.now() > deadline) throw error;
      console.log("The image is not sandbox-ready yet; trying again in 60 s.");
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  }
}

async function root(sandbox: Sandbox, script: string): Promise<void> {
  const command = await sandbox.runCommand({ cmd: "bash", args: ["-c", script] });
  if (command.exitCode !== 0) throw new Error(`Sandbox setup failed (${String(command.exitCode)}): ${(await command.stderr()).slice(-1_000)}`);
}

/**
 * The bundle and the probes in the Sandbox, the runtime installed from the
 * bundle as a task installs its release, and the probes' task tree with the
 * ownership a task's preparation leaves the child (task-directory.ts).
 */
async function prepare(sandbox: Sandbox, payload: string, bundle: RuntimeBundle, layout: RuntimeLayout): Promise<void> {
  await sandbox.writeFiles([
    { path: `${STAGING}/runtime-bundle.tar.gz`, content: await readFile(join(payload, "runtime-bundle.tar.gz")) },
    ...await Promise.all(PROBES.map(async (probe) => ({ path: `${STAGING}/${probe}`, content: await readFile(join(payload, probe)) }))),
  ]);
  await installRuntime(sandbox, bundle);
  const owner = `${String(SANDBOX_AGENT_UID)}:${String(SANDBOX_AGENT_GID)}`;
  const tree = [layout.inputDirectory, layout.outputDirectory, layout.controlDirectory, layout.workDirectory, layout.authDirectory, layout.homeDirectory];
  await root(sandbox, [
    "set -eu",
    `mkdir -p ${tree.join(" ")} /run/agent-browser`,
    `chown -R ${owner} ${layout.taskRoot} ${layout.authDirectory} ${layout.homeDirectory} /run/agent-browser ${PROBES.map((probe) => `${STAGING}/${probe}`).join(" ")}`,
  ].join("\n"));
}

/** The Sandbox's own environment, as the task executor there has it: what the child's allowlist is filled from. */
async function sandboxEnvironment(sandbox: Sandbox): Promise<NodeJS.ProcessEnv> {
  const command = await sandbox.runCommand({ cmd: "env", args: ["-0"] });
  const base = { ...process.env };
  for (const key of Object.keys(base)) delete base[key];
  for (const entry of (await command.stdout()).split("\0").filter(Boolean)) {
    const at = entry.indexOf("=");
    base[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return base;
}

/**
 * One probe, as the runner child is run: the agent user, in its task tree,
 * with nothing in its environment but the child's. Passed when its one JSON
 * line says `ok` — and, for the browser, that it runs without WebMCP's
 * features.
 */
async function runProbe(sandbox: Sandbox, layout: RuntimeLayout, probe: string): Promise<{ passed: boolean; result: unknown }> {
  const env = childEnvironment(
    await sandboxEnvironment(sandbox),
    layout,
    randomBytes(32).toString("hex"),
    randomBytes(18).toString("base64url"),
    join(layout.inputDirectory, "suite.json"),
  );
  const assignments = Object.entries(env).map(([name, value]) => `${name}=${String(value)}`);
  const command = await sandbox.runCommand(sandboxAgentCommand({
    cmd: "env", args: ["-i", ...assignments, "node", `${STAGING}/${probe}`], cwd: layout.workDirectory,
  }));
  const line = (await command.stdout()).split("\n").filter((entry) => entry.startsWith("{")).at(-1);
  let result: Record<string, unknown> | null = null;
  try {
    result = line ? JSON.parse(line) : null;
  } catch {
    result = null;
  }
  const passed = command.exitCode === 0 && result?.ok === true && !String(result.enableFeatures).includes("WebMCP");
  return { passed, result: result ?? { exitCode: command.exitCode, stderr: (await command.stderr()).slice(-1_500) } };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { image: { type: "string" }, payload: { type: "string" } } });
  if (!values.image || !values.payload) throw new Error("Usage: sandbox-browser-smoke.mjs --image <ref> --payload <payload directory>");
  const bundle = { version: bundleVersion(join(values.payload, "runtime-bundle.tar.gz")), url: `file://${STAGING}/runtime-bundle.tar.gz`, token: null };
  // The task root as a task's executor derives it (vercel-sandbox-task/environment.ts: /shipbash).
  const layout = runtimeLayout({ rootDirectory: "/shipbash", runtimeDirectory: runtimeDirectory(bundle) }, "shipbash-runner", "sandbox-smoke", {});
  const sandbox = await createSandbox(values.image);
  console.log(`Sandbox ${sandbox.name} from ${values.image}, runtime ${bundle.version}`);
  let passed = false;
  try {
    await prepare(sandbox, values.payload, bundle, layout);
    passed = true;
    for (const probe of PROBES) {
      const outcome = await runProbe(sandbox, layout, probe);
      console.log(`${outcome.passed ? "PASS" : "FAIL"} ${probe} ${JSON.stringify(outcome.result)}`);
      passed &&= outcome.passed;
    }
  } finally {
    await sandbox.stop().catch(() => undefined);
    await sandbox.delete().catch(() => undefined);
    console.log(`Sandbox ${sandbox.name} deleted.`);
  }
  if (!passed) process.exit(1);
}

await main();
