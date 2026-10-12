/**
 * The Activity runtime directory: the trusted checkout it may read, the
 * control channels the container talks back over, and the inputs it starts on.
 */
import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ActivityControlSeed, prepareActivityControlChannels } from "../activity-control-files.ts";
import { type TaskApiConfig, writeTaskApiConfig } from "@shipbash/contracts/runtime/job-api.mjs";
import { encryptAgentBrowserState, ensureAuthEncryptionKey } from "../docker-runtime.ts";
import { writeRunCodexConfig } from "../runner-agent-services.ts";
import {
  prepareTrustedAccessDirectory,
  type TrustedAccessRuntimeConfig,
} from "../trusted-access-runtime.ts";
import { activityInputForContainer, type ActivityRuntimeInput } from "./input.ts";
import { checkedAbsolutePath, pathContains } from "./paths.ts";

/** The options the layout is seeded from; a subset of ActivityRuntimeOptions. */
export interface ActivityRuntimeSeedOptions extends ActivityControlSeed {
  authDirectory?: string;
  authState?: Record<string, unknown>;
  taskApi?: TaskApiConfig;
  temporaryDirectory?: string;
  repositoryCheckoutRoot?: string;
  trustedAccess?: TrustedAccessRuntimeConfig | null;
}

export interface ActivityRuntimeLayout {
  repositoryDirectory: string;
  runtimeDirectory: string;
  inputDirectory: string;
  outputDirectory: string;
  controlDirectory: string;
  authDirectory: string;
  encryptionKey: string;
  trustedAccess: TrustedAccessRuntimeConfig | null;
  trustedAccessDirectory: string | undefined;
}

export async function prepareActivityRuntimeLayout(
  input: ActivityRuntimeInput,
  options: ActivityRuntimeSeedOptions,
): Promise<ActivityRuntimeLayout> {
  const checkoutRootValue = options.repositoryCheckoutRoot;
  if (!checkoutRootValue) throw new Error("A trusted repository checkout root is required.");
  const checkoutRoot = await realpath(checkedAbsolutePath(checkoutRootValue, "repositoryCheckoutRoot"));
  const repositoryDirectory = await realpath(input.repositoryCheckoutLocator);
  if (!(await stat(repositoryDirectory)).isDirectory()) throw new Error("Repository checkout locator is not a directory.");
  if (repositoryDirectory === checkoutRoot || !pathContains(checkoutRoot, repositoryDirectory)) {
    throw new Error("Repository checkout locator is outside the trusted checkout root.");
  }
  const temporaryParent = options.temporaryDirectory
    ? checkedAbsolutePath(options.temporaryDirectory, "temporaryDirectory")
    : tmpdir();
  await mkdir(temporaryParent, { recursive: true });
  const runtimeDirectory = await mkdtemp(join(temporaryParent, "shipbash-activity-"));
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
  await prepareActivityControlChannels(controlDirectory, options);
  await writeTaskApiConfig(controlDirectory, options.taskApi);
  const encryptionKey = await ensureAuthEncryptionKey(authDirectory);
  if (options.authState) {
    await writeFile(join(authDirectory, "state.json.enc"), encryptAgentBrowserState(options.authState, encryptionKey), { mode: 0o600 });
  }
  await writeFile(join(inputDirectory, "activity.json"), `${JSON.stringify(activityInputForContainer(input))}\n`, { mode: 0o600 });
  await writeRunCodexConfig(inputDirectory);
  const { trustedAccess, trustedAccessDirectory } = await prepareTrustedAccessDirectory(
    join(runtimeDirectory, "trusted-access"),
    options.trustedAccess,
    input.productionUrl,
  );
  return {
    repositoryDirectory,
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
