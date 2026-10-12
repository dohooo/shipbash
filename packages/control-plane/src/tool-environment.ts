import { join, resolve } from "node:path";

import { withoutRemoteRunnerCredentials } from "./local-environment.ts";

export function isolatedToolEnvironment(
  base: NodeJS.ProcessEnv,
  toolHomeValue: string,
): NodeJS.ProcessEnv {
  const toolHome = resolve(toolHomeValue);
  const environment = withoutRemoteRunnerCredentials(base);
  environment.HOME = toolHome;
  environment.XDG_CACHE_HOME = join(toolHome, ".cache");
  environment.XDG_CONFIG_HOME = join(toolHome, ".config");
  environment.XDG_DATA_HOME = join(toolHome, ".local", "share");
  environment.npm_config_cache = join(toolHome, ".npm");
  environment.DOCKER_CONFIG = join(toolHome, ".docker");
  environment.BUILDX_CONFIG = join(toolHome, ".docker", "buildx");
  environment.SUPABASE_HOME = join(toolHome, ".supabase");
  environment.SUPABASE_TELEMETRY_DISABLED = "1";
  environment.NEXT_TELEMETRY_DISABLED = "1";
  return environment;
}

export function toolProcessEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const toolHome = base.SHIPBASH_TOOL_PROCESS_HOME ?? base.SHIPBASH_TOOL_HOME;
  return toolHome
    ? isolatedToolEnvironment(base, toolHome)
    : withoutRemoteRunnerCredentials(base);
}
