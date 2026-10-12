import { join, resolve } from "node:path";

import { shipbashEnvironmentValue } from "../environment.ts";
import { secureDirectory } from "./secure-paths.ts";

export function toolHomeForWorkdir(
  workdir: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(shipbashEnvironmentValue(environment, "TOOL_HOME") ?? join(resolve(workdir), "tool-home"));
}

export async function prepareToolHomes(toolHomeRoot: string): Promise<void> {
  await secureDirectory(toolHomeRoot, "ShipBash tool-home root");
  for (const role of ["supervisor", "runner", "web"]) {
    const home = await secureDirectory(join(toolHomeRoot, role), `ShipBash ${role} tool home`);
    for (const path of [
      join(home, ".cache"),
      join(home, ".config"),
      join(home, ".docker"),
      join(home, ".docker", "buildx"),
      join(home, ".local"),
      join(home, ".local", "share"),
      join(home, ".npm"),
      join(home, ".supabase"),
      join(home, "Library"),
      join(home, "Library", "Containers"),
      join(home, "Library", "Containers", "com.docker.docker"),
      join(home, "Library", "Containers", "com.docker.docker", "Data"),
    ]) {
      await secureDirectory(path, `ShipBash ${role} tool-home path`);
    }
  }
}
