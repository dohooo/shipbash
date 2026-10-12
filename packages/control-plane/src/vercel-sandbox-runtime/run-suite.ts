import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  NdjsonEventParser,
  type DockerRuntimeEvent,
  type DockerRuntimeOptions,
  type DockerSuiteInput,
  type DockerSuiteRunResult,
  mapContainerExit,
  suiteInputForContainer,
  validateSuiteInput,
} from "../docker-runtime.ts";
import { writeTaskApiConfig } from "@shipbash/contracts/runtime/job-api.mjs";

import { writeCaseOpenings } from "../agent-data/opening.ts";
import { suiteBrowserStream } from "./browser-stream.ts";
import type { SandboxRuntimeContext } from "./configuration.ts";
import { dispatchProcess } from "./dispatch.ts";
import { runtimeLayout } from "./paths.ts";
import {
  prepareChildOwnership,
  prepareLayout,
  removeTaskRoot,
  seedAuthDirectory,
  writeTrustedAccess,
} from "./task-directory.ts";

export async function runSuiteInSandbox(
  context: SandboxRuntimeContext,
  inputValue: DockerSuiteInput,
  onEvent: (event: DockerRuntimeEvent) => void | Promise<void>,
  signal: AbortSignal,
  runtimeOptions: DockerRuntimeOptions,
): Promise<DockerSuiteRunResult> {
  const input = validateSuiteInput(inputValue);
  const layout = runtimeLayout(context, "shipbash-runner", input.suiteRunId, runtimeOptions);
  await prepareLayout(layout);
  const encryptionKey = await seedAuthDirectory(
    layout.authDirectory,
    input.authState,
    runtimeOptions.encryptionKey,
  );
  const inputPath = join(layout.inputDirectory, "suite.json");
  await writeFile(inputPath, `${JSON.stringify(suiteInputForContainer(input))}\n`, { mode: 0o600 });
  if (runtimeOptions.caseOpenings) await writeCaseOpenings(layout.controlDirectory, runtimeOptions.caseOpenings);
  const humanAuthPassword = randomBytes(24).toString("base64url");
  const sensitiveValues = [
    humanAuthPassword,
    ...(runtimeOptions.trustedAccess ? [runtimeOptions.trustedAccess.headerValue] : []),
  ];
  try {
    // The header file lives from here until the runner takes it (dispatch.ts);
    // a run that fails before the runner starts takes it away with its root.
    const trustedAccessWritten = await writeTrustedAccess(
      layout,
      runtimeOptions.trustedAccess,
      input.productionUrl,
    );
    await writeTaskApiConfig(layout.controlDirectory, runtimeOptions.taskApi);
    await prepareChildOwnership(layout, context.childUid, context.childGid);
    runtimeOptions.onOutputDirectoryReady?.(layout.outputDirectory);
    const result = await dispatchProcess(context, layout, {
      script: context.suiteRunnerScript,
      encryptionKey,
      humanAuthPassword,
      inputPath,
      trustedAccessWritten,
      sensitiveValues,
      signal,
      parser: new NdjsonEventParser(sensitiveValues),
      onEvent: async (event) => {
        const stream = suiteBrowserStream(event, context.resolveBrowserStream, input.suiteRunId);
        await onEvent(stream === null ? event : { ...event, ...await stream });
      },
    });
    return {
      status: mapContainerExit(result.exitCode, result.aborted, result.lastEvent?.type),
      exitCode: result.exitCode,
      outputDirectory: layout.outputDirectory,
      authDirectory: layout.authDirectory,
    };
  } catch (error) {
    await runtimeOptions.onBeforeOutputCleanup?.();
    await removeTaskRoot(layout.taskRoot);
    throw error;
  } finally {
    await Promise.all([
      rm(layout.inputDirectory, { recursive: true, force: true }),
      rm(join(layout.controlDirectory, "cancel"), { force: true }),
      rm(join(layout.controlDirectory, "auth-complete"), { force: true }),
      rm(join(layout.controlDirectory, "auth-cancel"), { force: true }),
    ]);
  }
}
