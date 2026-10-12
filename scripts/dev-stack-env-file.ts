/**
 * The local stack's configuration files and how their values reach the
 * process, read the way Next.js reads its own: the real environment first,
 * then `.env.local`, then `.env`.
 *
 * `.env` names the services this ShipBash calls and the integrations it
 * offers (.env.example); `.env.local` is this machine's own: its loopback
 * OAuth apps, the secrets the stack generates, its knobs (.env.local.example).
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

/**
 * The files are machine configuration, not repository content: every
 * worktree talks to the same local Supabase instance and the same OAuth
 * apps, so they all read the files at the main checkout's root. From a
 * worktree `--git-common-dir` is the main checkout's `.git`; from the main
 * checkout it is our own, so a single path covers both.
 */
function configRoot(): string {
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", { cwd: ROOT, encoding: "utf8" }).trim();
    return dirname(resolve(ROOT, commonDir));
  } catch {
    return ROOT;
  }
}

export const CONFIG_ROOT = configRoot();
export const ENV_FILE = join(CONFIG_ROOT, ".env");
/** Where the stack writes the secrets it generates. */
export const LOCAL_ENV_FILE = join(CONFIG_ROOT, ".env.local");

/**
 * .env loader: a value already in the environment always wins over the file,
 * so one-off overrides (e.g. SHIPBASH_DOCKER_BINARY) keep working.
 */
export function applyEnvFile(contents: string, environment: NodeJS.ProcessEnv): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parseEnv(contents))) {
    if (environment[key] !== undefined) continue;
    environment[key] = value;
    applied.push(key);
  }
  return applied;
}

/** Applies `root`'s `.env.local`, then its `.env`, each when it exists: what each one set, by file. */
export function loadEnvFiles(root: string, environment: NodeJS.ProcessEnv): { file: string; applied: string[] }[] {
  return [join(root, ".env.local"), join(root, ".env")]
    .filter((file) => existsSync(file))
    .map((file) => ({ file, applied: applyEnvFile(readFileSync(file, "utf8"), environment) }));
}
