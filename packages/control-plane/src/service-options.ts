/**
 * How the service is configured when it is started from a command line.
 *
 * Flags win over environment, and both are validated here rather than at the
 * first use: a bad port or a missing key should stop the process at startup
 * with a sentence that names it, not surface later as a failure nobody can
 * place. The deployment's configuration is read here, once (configuration.ts).
 */
import { resolve } from "node:path";

import { readConfiguration } from "./configuration.ts";
import { shipbashProcessEnvironmentValue } from "./environment.ts";
import { DEFAULT_PORT } from "./service/support.ts";
import type { ShipBashServiceOptions } from "./service.ts";

export function serviceOptions(): ShipBashServiceOptions {
  const args = process.argv.slice(2);
  const valueAfter = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const projectRoot = resolve(valueAfter("--project") ?? shipbashProcessEnvironmentValue("PROJECT_PATH") ?? process.cwd());
  const rawPort = valueAfter("--port") ?? shipbashProcessEnvironmentValue("PORT") ?? process.env.PORT ?? String(DEFAULT_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid ShipBash port: ${rawPort}`);
  return {
    projectRoot,
    configuration: readConfiguration(process.env, "local"),
    port,
  };
}
