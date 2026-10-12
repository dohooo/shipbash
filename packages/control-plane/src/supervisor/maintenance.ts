import { join } from "node:path";

import { shipbashEnvironmentValue } from "../environment.ts";
import { isolatedToolEnvironment } from "../tool-environment.ts";
import { command } from "./command.ts";
import { ensureLoopbackNetwork, repairExistingSupabaseDatabaseNetwork } from "./docker-network.ts";
import { ensureLocalSupabase } from "./ensure-local-supabase.ts";
import { moduleRequire } from "./paths.ts";
import {
  type LocalSupabaseMaintenanceAction,
  localSupabaseMaintenanceArgs,
  supabaseResetReachedRestartPhase,
} from "./supabase-commands.ts";
import { toolHomeForWorkdir } from "./tool-home.ts";
import { prepareLocalSupabaseWorkdir } from "./workdir.ts";

export async function runLocalSupabaseMaintenance(
  root: string,
  action: LocalSupabaseMaintenanceAction,
): Promise<void> {
  const workdir = await prepareLocalSupabaseWorkdir(root);
  const supabaseBinary = moduleRequire.resolve("supabase/dist/supabase.js");
  const environment = isolatedToolEnvironment(
    process.env,
    join(toolHomeForWorkdir(workdir), "supervisor"),
  );
  const result = await command(
    supabaseBinary,
    localSupabaseMaintenanceArgs(action, workdir),
    { cwd: workdir, env: environment },
  );
  if (result.exitCode !== 0) {
    if (
      action === "reset"
      && supabaseResetReachedRestartPhase(`${result.stdout}\n${result.stderr}`)
    ) {
      const dockerBinary = shipbashEnvironmentValue(process.env, "DOCKER_BINARY") ?? "docker";
      await ensureLoopbackNetwork(dockerBinary, environment);
      if (await repairExistingSupabaseDatabaseNetwork(dockerBinary, environment)) {
        const stopped = await command(
          supabaseBinary,
          localSupabaseMaintenanceArgs("stop", workdir),
          { cwd: workdir, env: environment },
        );
        if (stopped.exitCode !== 0) {
          throw new Error(
            `Local Supabase could not restart safely after reset: ${stopped.stderr.trim() || stopped.stdout.trim()}`,
          );
        }
        await ensureLocalSupabase(root);
        process.stderr.write(
          "ShipBash repaired the local Supabase network after database reset.\n",
        );
        return;
      }
    }
    throw new Error(
      `Local Supabase ${action} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}
