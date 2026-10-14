/**
 * The Suite runtime directory: what the host lays out on disk before Docker
 * binds it, and the inputs the container reads from it.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type TaskApiConfig, writeTaskApiConfig } from "@shipbash/contracts/runtime/job-api.mjs";

import { writeCaseOpenings } from "../agent-data/opening.ts";
import type { RunHistoryWalk } from "../run-history.ts";
import {
  prepareTrustedAccessDirectory,
  type TrustedAccessRuntimeConfig,
} from "../trusted-access-runtime.ts";
import { encryptAgentBrowserState, ensureAuthEncryptionKey } from "./auth-state.ts";
import { suiteInputForContainer, type DockerSuiteInput } from "./input.ts";
import { writeRunCodexConfig } from "../runner-agent-services.ts";
import { checkedAbsolutePath } from "./validate.ts";

export interface SuiteRuntimeOptions {
  taskApi?: TaskApiConfig;
  authDirectory?: string;
  encryptionKey?: string;
  temporaryDirectory?: string;
  trustedAccess?: TrustedAccessRuntimeConfig | null;
  caseOpenings?: Record<string, RunHistoryWalk>;
}

export interface SuiteRuntimeLayout {
  runtimeDirectory: string;
  inputDirectory: string;
  outputDirectory: string;
  controlDirectory: string;
  authDirectory: string;
  encryptionKey: string;
  trustedAccess: TrustedAccessRuntimeConfig | null;
  trustedAccessDirectory: string | undefined;
}

/** Lays out the runtime directory the container binds, and seeds its inputs. */
export async function prepareSuiteRuntimeLayout(
  suite: DockerSuiteInput,
  options: SuiteRuntimeOptions,
): Promise<SuiteRuntimeLayout> {
  const temporaryParent = options.temporaryDirectory
    ? checkedAbsolutePath(options.temporaryDirectory, "temporaryDirectory")
    : tmpdir();
  await mkdir(temporaryParent, { recursive: true });
  const runtimeDirectory = await mkdtemp(join(temporaryParent, "shipbash-runner-"));
  const inputDirectory = join(runtimeDirectory, "input");
  const outputDirectory = join(runtimeDirectory, "output");
  const controlDirectory = join(runtimeDirectory, "control");
  const authDirectory = options.authDirectory
    ? checkedAbsolutePath(options.authDirectory, "authDirectory")
    : join(controlDirectory, "auth");
  await Promise.all([
    mkdir(inputDirectory, { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
    mkdir(controlDirectory, { recursive: true }),
    mkdir(authDirectory, { recursive: true }),
  ]);
  await writeTaskApiConfig(controlDirectory, options.taskApi);
  const encryptionKey = await ensureAuthEncryptionKey(
    authDirectory,
    options.encryptionKey,
  );
  if (suite.authState) {
    await writeFile(
      join(authDirectory, "state.json.enc"),
      encryptAgentBrowserState(suite.authState, encryptionKey),
      { mode: 0o600 },
    );
  }
  await writeFile(
    join(inputDirectory, "suite.json"),
    `${JSON.stringify(suiteInputForContainer(suite))}\n`,
    {
    mode: 0o600,
    },
  );
  await writeRunCodexConfig(inputDirectory);
  if (options.caseOpenings) await writeCaseOpenings(controlDirectory, options.caseOpenings);
  const { trustedAccess, trustedAccessDirectory } = await prepareTrustedAccessDirectory(
    join(runtimeDirectory, "trusted-access"),
    options.trustedAccess,
    suite.productionUrl,
  );
  return {
    runtimeDirectory,
    inputDirectory,
    outputDirectory,
    controlDirectory,
    authDirectory,
    encryptionKey,
    trustedAccess,
    trustedAccessDirectory,
  };
}
