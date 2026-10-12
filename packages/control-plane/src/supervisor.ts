// Thin entry for the local Supabase supervisor, which lives in ./supervisor/.
// The `db:*` scripts run `node packages/control-plane/dist/supervisor.js`, so
// the direct-invocation dispatch below has to stay here — it compares
// process.argv[1] against this module's own URL. The dev stack imports
// ensureLocalSupabase from here. The directory is the map: the loopback
// constants, the packaged paths, the symlink-refusing filesystem guards, the
// GitHub identity provider injection, the tool homes, the writable workdir,
// the collected command wrapper, the Supabase status and CLI argument readers,
// the Docker network repair, the Supabase bring-up and the maintenance actions
// each live in their own module.
import { isDirectInvocation } from "./direct-invocation.ts";
import { ensureLocalSupabase } from "./supervisor/ensure-local-supabase.ts";
import { runLocalSupabaseMaintenance } from "./supervisor/maintenance.ts";
import { packageRoot } from "./supervisor/paths.ts";

export { SUPABASE_EXCLUDED_SERVICES } from "./supervisor/constants.ts";
export {
  containerUsesDockerNetwork,
  publiclyBoundSupabasePorts,
} from "./supervisor/docker-network.ts";
export { ensureLocalSupabase } from "./supervisor/ensure-local-supabase.ts";
export { configuredLocalOAuthProviders, localOAuthProviderConfig } from "./supervisor/oauth-providers.ts";
export { runLocalSupabaseMaintenance } from "./supervisor/maintenance.ts";
export {
  localSupabaseMaintenanceArgs,
  localSupabaseMigrationArgs,
  supabaseResetReachedRestartPhase,
} from "./supervisor/supabase-commands.ts";
export {
  type LocalSupabaseEnvironment,
  localSupabaseAuthProviderRequiresRestart,
  localSupabaseStartAlreadyRunning,
  parseSupabaseStatus,
} from "./supervisor/supabase-status.ts";
export { prepareLocalSupabaseWorkdir } from "./supervisor/workdir.ts";

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  if (process.argv.includes("--db-only")) {
    await ensureLocalSupabase(packageRoot());
    process.stdout.write("ShipBash local Supabase is ready.\n");
  } else if (process.argv.includes("--db-stop")) {
    await runLocalSupabaseMaintenance(packageRoot(), "stop");
  } else if (process.argv.includes("--db-reset")) {
    await runLocalSupabaseMaintenance(packageRoot(), "reset");
  } else if (process.argv.includes("--db-lint")) {
    await runLocalSupabaseMaintenance(packageRoot(), "lint");
  } else {
    process.stderr.write("Usage: supervisor.js --db-only | --db-stop | --db-reset | --db-lint\n");
    process.exitCode = 2;
  }
}
