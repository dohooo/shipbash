import { appendFile, chmod, copyFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { shipbashEnvironmentValue } from "../environment.ts";
import { localOAuthProviderConfig } from "./oauth-providers.ts";
import { rejectSymlinkOrNonFile, requirePackagedPath, secureDirectory } from "./secure-paths.ts";
import { prepareToolHomes, toolHomeForWorkdir } from "./tool-home.ts";

export async function prepareLocalSupabaseWorkdir(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const packagedSupabase = join(root, "supabase");
  const home = shipbashEnvironmentValue(environment, "HOME");
  const workdir = resolve(
    shipbashEnvironmentValue(environment, "CONTROL_PLANE_ROOT") ??
      (home
        ? join(resolve(home), "control-plane")
        : join(
            resolve(environment.TMPDIR ?? tmpdir()),
            `shipbash-control-plane-${String(process.getuid?.() ?? "user")}`,
          )),
  );
  const supabaseDirectory = join(workdir, "supabase");
  const packagedConfig = join(packagedSupabase, "config.toml");
  const packagedMigrations = join(packagedSupabase, "migrations");
  const destinationConfig = join(supabaseDirectory, "config.toml");
  const destinationMigrations = join(supabaseDirectory, "migrations");
  await requirePackagedPath(packagedConfig, "Packaged Supabase config", "file");
  await requirePackagedPath(packagedMigrations, "Packaged Supabase migrations", "directory");
  await secureDirectory(workdir, "ShipBash control-plane directory");
  await prepareToolHomes(toolHomeForWorkdir(workdir, environment));
  await secureDirectory(supabaseDirectory, "ShipBash Supabase directory");
  await rejectSymlinkOrNonFile(destinationConfig, "ShipBash Supabase config");
  await copyFile(packagedConfig, destinationConfig);
  const providers = localOAuthProviderConfig(environment);
  if (providers) await appendFile(destinationConfig, providers, { encoding: "utf8" });
  await chmod(destinationConfig, 0o600);
  // Migrations are immutable package input. Rebuild this directory so a removed or locally
  // injected migration can never survive into the trusted control plane.
  await rm(destinationMigrations, { recursive: true, force: true });
  await cp(packagedMigrations, destinationMigrations, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  await chmod(destinationMigrations, 0o700);
  return workdir;
}
