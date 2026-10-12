// Removes the Sandboxes nothing will come back for. Every Sandbox is
// one-shot now — a task, a sign-in takeover, a sign-in handoff, a browser
// smoke — and is deleted by the flow that created it; this removes what a
// crashed flow left behind once it is older than a day, snapshots included.
// Weekly from .github/workflows/sandbox-sweep.yml; `--dry-run` only lists.
import { pathToFileURL } from "node:url";

import { Sandbox } from "@vercel/sandbox";

const MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const ONE_SHOT_PREFIXES = ["shipbash-task-", "shipbash-signin-", "shipbash-handoff-", "shipbash-smoke-"];

/** Whether a listed Sandbox goes: a one-shot one, once it is a day old. */
export function shouldSweep(sandbox, now = Date.now()) {
  return ONE_SHOT_PREFIXES.some((prefix) => sandbox.name.startsWith(prefix)) && sandbox.createdAt <= now - MAX_AGE_MS;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const credentials = {
    token: process.env.VERCEL_TOKEN,
    teamId: process.env.VERCEL_TEAM_ID,
    projectId: process.env.VERCEL_PROJECT_ID,
  };
  for (const [name, value] of Object.entries(credentials)) {
    if (!value) {
      console.error(`${name.replace(/[A-Z]/gu, (c) => `_${c}`).toUpperCase()} is required.`);
      process.exit(2);
    }
  }

  let removed = 0;
  for (const prefix of ONE_SHOT_PREFIXES) {
    // The list pages itself; iterating walks every sandbox with the prefix.
    for await (const sandbox of await Sandbox.list({ ...credentials, namePrefix: prefix, sortBy: "name", limit: 50 })) {
      if (!shouldSweep(sandbox)) continue;
      console.log(`${dryRun ? "would remove" : "removing"} ${sandbox.name} (${sandbox.status}, ${new Date(sandbox.createdAt).toISOString()})`);
      if (dryRun) continue;
      const handle = await Sandbox.get({ ...credentials, name: sandbox.name, resume: false });
      await handle.stop().catch(() => undefined);
      await handle.delete({ deleteOrphanSnapshots: true });
      removed += 1;
    }
  }
  console.log(`${dryRun ? "dry run, nothing" : String(removed)} removed`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
