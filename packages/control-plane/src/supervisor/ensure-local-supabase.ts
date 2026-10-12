import { join } from "node:path";

import { verifyArtifactStorageReadiness } from "../artifact-storage.ts";
import { verifyBrowserRecordingStorageReadiness } from "../browser-recording-storage.ts";
import { shipbashEnvironmentValue } from "../environment.ts";
import { isolatedToolEnvironment } from "../tool-environment.ts";
import { command } from "./command.ts";
import { SUPABASE_EXCLUDED_SERVICES, SUPABASE_NETWORK } from "./constants.ts";
import {
  ensureLoopbackNetwork,
  repairExistingSupabaseDatabaseNetwork,
  warnIfSupabasePortsArePublic,
} from "./docker-network.ts";
import { configuredLocalOAuthProviders, type LocalOAuthProvider } from "./oauth-providers.ts";
import { moduleRequire } from "./paths.ts";
import {
  localSupabaseMaintenanceArgs,
  localSupabaseMigrationArgs,
} from "./supabase-commands.ts";
import {
  type LocalSupabaseEnvironment,
  localSupabaseAuthProviderRequiresRestart,
  localSupabaseStartAlreadyRunning,
  parseSupabaseStatus,
} from "./supabase-status.ts";
import { toolHomeForWorkdir } from "./tool-home.ts";
import { prepareLocalSupabaseWorkdir } from "./workdir.ts";

/** How long a start already in flight is given to finish before we give up. */
const START_IN_FLIGHT_TIMEOUT_MS = 300_000;
const START_IN_FLIGHT_POLL_MS = 3_000;

/**
 * Wait out a `supabase start` that another process is already running.
 *
 * The CLI's lock is what makes this worth waiting on rather than failing: a
 * cold stack takes longer to come up than a caller that gave up on it, so the
 * abandoned start keeps going and every later attempt is refused by it. Treated
 * as an error, that is self-locking — one slow start poisons every run after
 * it until someone finds the stray process. Treated as "it is arriving", it
 * settles by itself.
 */
async function awaitStartInFlight(
  supabaseBinary: string,
  workdir: string,
  environment: NodeJS.ProcessEnv,
  deadline: number,
): Promise<boolean> {
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, START_IN_FLIGHT_POLL_MS));
    const status = await command(
      supabaseBinary,
      ["status", "--workdir", workdir, "--output", "json"],
      { cwd: workdir, env: environment },
    );
    // `status` answers only once every container the project needs is up, so
    // a clean exit is the in-flight start having finished the job for us.
    if (status.exitCode === 0) return true;
  }
  return false;
}

/**
 * `supabase start` runs three times in the worst case — once normally, once
 * after a Docker network repair, once after an Auth configuration change — and
 * each failure reports the same result with a different lead-in. The closure
 * builds the argument list once, exactly as the single inline list did.
 */
function supabaseStarter(
  supabaseBinary: string,
  workdir: string,
  environment: NodeJS.ProcessEnv,
): (failure: string) => Promise<void> {
  const startArguments = [
    "start",
    "--workdir",
    workdir,
    "--network-id",
    SUPABASE_NETWORK,
    "--exclude",
    SUPABASE_EXCLUDED_SERVICES,
    "--yes",
  ];
  return async (failure: string): Promise<void> => {
    const started = await command(supabaseBinary, startArguments, { cwd: workdir, env: environment });
    if (started.exitCode === 0) return;
    const output = started.stderr.trim() || started.stdout.trim();
    if (localSupabaseStartAlreadyRunning(output)) {
      const deadline = Date.now() + START_IN_FLIGHT_TIMEOUT_MS;
      if (await awaitStartInFlight(supabaseBinary, workdir, environment, deadline)) return;
      throw new Error(
        `${failure}: another \`supabase start\` held the project for ${String(START_IN_FLIGHT_TIMEOUT_MS / 1_000)}s without finishing. Stop it, or run \`supabase stop --workdir ${workdir}\`, then try again.`,
      );
    }
    throw new Error(`${failure}: ${output}`);
  };
}

async function readSupabaseEnvironment(
  supabaseBinary: string,
  workdir: string,
  environment: NodeJS.ProcessEnv,
): Promise<LocalSupabaseEnvironment> {
  const status = await command(
    supabaseBinary,
    ["status", "--workdir", workdir, "--output", "json"],
    { cwd: workdir, env: environment },
  );
  if (status.exitCode !== 0) {
    throw new Error(`Local Supabase status failed: ${status.stderr.trim()}`);
  }
  return parseSupabaseStatus(status.stdout);
}

async function restartForAuthProviderChange(input: {
  supabaseBinary: string;
  workdir: string;
  environment: NodeJS.ProcessEnv;
  apiUrl: string;
  providersExpected: readonly LocalOAuthProvider[];
  start: (failure: string) => Promise<void>;
}): Promise<void> {
  const authSettings = await fetch(`${input.apiUrl}/auth/v1/settings`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!authSettings.ok) {
    throw new Error(`Local Supabase Auth settings failed with HTTP ${String(authSettings.status)}.`);
  }
  const settings = await authSettings.text();
  if (!localSupabaseAuthProviderRequiresRestart(input.providersExpected, settings)) return;
  const stopped = await command(
    input.supabaseBinary,
    localSupabaseMaintenanceArgs("stop", input.workdir),
    { cwd: input.workdir, env: input.environment },
  );
  if (stopped.exitCode !== 0) {
    throw new Error(
      `Local Supabase could not restart after an Auth configuration change: ${stopped.stderr.trim() || stopped.stdout.trim()}`,
    );
  }
  await input.start("Local Supabase failed after applying its Auth configuration");
}

export async function ensureLocalSupabase(
  root: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<LocalSupabaseEnvironment> {
  const supabaseBinary = moduleRequire.resolve("supabase/dist/supabase.js");
  const dockerBinary = shipbashEnvironmentValue(baseEnvironment, "DOCKER_BINARY") ?? "docker";
  const providersExpected = configuredLocalOAuthProviders(baseEnvironment);
  const workdir = await prepareLocalSupabaseWorkdir(root, baseEnvironment);
  const toolHome = toolHomeForWorkdir(workdir, baseEnvironment);
  const toolEnvironment = isolatedToolEnvironment(baseEnvironment, join(toolHome, "supervisor"));
  process.env.SHIPBASH_TOOL_HOME = toolHome;
  process.env.SHIPBASH_TOOL_PROCESS_HOME = join(toolHome, "supervisor");
  await ensureLoopbackNetwork(dockerBinary, toolEnvironment);
  await repairExistingSupabaseDatabaseNetwork(dockerBinary, toolEnvironment);
  const start = supabaseStarter(supabaseBinary, workdir, toolEnvironment);
  await start("Local Supabase failed to start");
  if (await repairExistingSupabaseDatabaseNetwork(dockerBinary, toolEnvironment)) {
    await start("Local Supabase failed after repairing its Docker network");
  }
  const initialEnvironment = await readSupabaseEnvironment(supabaseBinary, workdir, toolEnvironment);
  await restartForAuthProviderChange({
    supabaseBinary,
    workdir,
    environment: toolEnvironment,
    apiUrl: initialEnvironment.apiUrl,
    providersExpected,
    start,
  });
  const migrated = await command(
    supabaseBinary,
    localSupabaseMigrationArgs(workdir),
    { cwd: workdir, env: toolEnvironment },
  );
  if (migrated.exitCode !== 0) {
    throw new Error(
      `Local Supabase migrations failed: ${migrated.stderr.trim() || migrated.stdout.trim()}`,
    );
  }
  const environment = await readSupabaseEnvironment(supabaseBinary, workdir, toolEnvironment);
  await verifyArtifactStorageReadiness({
    apiUrl: environment.apiUrl,
    serviceRoleKey: environment.serviceRoleKey,
  });
  await verifyBrowserRecordingStorageReadiness({
    apiUrl: environment.apiUrl,
    serviceRoleKey: environment.serviceRoleKey,
  });
  await warnIfSupabasePortsArePublic(dockerBinary, toolEnvironment);
  return environment;
}
