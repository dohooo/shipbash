/**
 * The per-session Trusted Production access runtime: the throwaway directory
 * pair the container binds, the config file the runner consumes once, and the
 * mounts that expose them.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  validateTrustedAccessRuntimeConfig,
  type TrustedAccessRuntimeConfig,
} from "../trusted-access-runtime.ts";
import { authSessionHash } from "./naming.ts";

export interface TrustedAccessRuntimePaths {
  runtimeDirectory: string;
  controlDirectory: string;
  trustedAccessDirectory: string;
}

export async function prepareTrustedAccessRuntime(
  authDirectory: string,
  runtimeId: string,
  productionUrl: string,
  trustedAccess: TrustedAccessRuntimeConfig | null | undefined,
): Promise<TrustedAccessRuntimePaths | null> {
  if (!trustedAccess) return null;
  const config = validateTrustedAccessRuntimeConfig(trustedAccess, productionUrl);
  const runtimeDirectory = join(authDirectory, `.trusted-access-${runtimeId}`);
  const controlDirectory = join(runtimeDirectory, "control");
  const trustedAccessDirectory = join(runtimeDirectory, "trusted-access");
  await rm(runtimeDirectory, { recursive: true, force: true });
  await Promise.all([
    mkdir(controlDirectory, { recursive: true }),
    mkdir(trustedAccessDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(trustedAccessDirectory, "config.json"),
    `${JSON.stringify(config)}\n`,
    { mode: 0o600 },
  );
  return { runtimeDirectory, controlDirectory, trustedAccessDirectory };
}

export async function removeTrustedAccessRuntime(authDirectory: string, sessionId: string): Promise<void> {
  await rm(join(authDirectory, `.trusted-access-${authSessionHash(sessionId)}`), {
    recursive: true,
    force: true,
  });
}

export function trustedAccessMountArgs(
  runtime: TrustedAccessRuntimePaths | null,
): string[] {
  return runtime
    ? [
        "--mount", `type=bind,src=${runtime.controlDirectory},dst=/shipbash/control`,
        "--mount", `type=bind,src=${runtime.trustedAccessDirectory},dst=/shipbash/trusted-access,readonly`,
      ]
    : [];
}
