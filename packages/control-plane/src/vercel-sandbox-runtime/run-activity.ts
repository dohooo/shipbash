import { randomBytes } from "node:crypto";
import { chown, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { prepareActivityControlChannels } from "../activity-control-files.ts";
import {
  ActivityNdjsonParser,
  type ActivityDockerRunResult,
  type ActivityRuntimeEvent,
  type ActivityRuntimeInput,
  type ActivityRuntimeOptions,
  readActivityResultFile,
  resultStatus,
  validateActivityRuntimeInput,
} from "../activity-runtime.ts";
import { writeTaskApiConfig } from "@shipbash/contracts/runtime/job-api.mjs";
import { activityBrowserStream } from "./browser-stream.ts";
import type { SandboxRuntimeContext } from "./configuration.ts";
import { dispatchProcess } from "./dispatch.ts";
import { runtimeLayout } from "./paths.ts";
import {
  copyRepositorySnapshot,
  linkSessionDirectory,
  prepareChildOwnership,
  prepareLayout,
  removeTaskRoot,
  seedAuthDirectory,
  writeTrustedAccess,
} from "./task-directory.ts";

/**
 * The worker beside this child delivers the owner's steers, answers and Stop
 * into this mount mid-run (dispatch-worker-control-inbox.ts). The hosted
 * runtime has no container start to announce, so it says where the mount is
 * itself — and what the worker writes there as root becomes the child's.
 */
async function reportControlMount(
  context: SandboxRuntimeContext,
  controlDirectory: string,
  runtimeOptions: ActivityRuntimeOptions,
): Promise<void> {
  await runtimeOptions.onControlMount?.({
    controlDirectory,
    adopt: (path) => chown(path, context.childUid, context.childGid),
  });
}

/**
 * The task directory the child starts in: the repository copy, the sealed
 * sign-in, its input, and a control mount seeded exactly as the Docker
 * runtime seeds its own (activity-runtime/prepare.ts) — page notes, the
 * history note, owed steers, where the task API answers, and the pi session
 * home at control/pi-session.
 */
async function prepareActivityTask(
  context: SandboxRuntimeContext,
  input: ActivityRuntimeInput,
  runtimeOptions: ActivityRuntimeOptions,
) {
  const layout = runtimeLayout(context, "shipbash-activity", input.activityId, runtimeOptions);
  await prepareLayout(layout);
  try {
    const repositoryRoot = await copyRepositorySnapshot(
      input.repositoryCheckoutLocator,
      layout.taskRoot,
      "Activity repository checkout locator is not a directory.",
    );
    const encryptionKey = await seedAuthDirectory(layout.authDirectory, runtimeOptions.authState);
    const inputPath = join(layout.inputDirectory, "activity.json");
    await writeFile(inputPath, `${JSON.stringify({
      ...input,
      repositoryCheckoutLocator: repositoryRoot,
    })}\n`, { mode: 0o600 });
    // The header file lives from here until the runner takes it (dispatch.ts);
    // a leg that fails before the runner starts takes it away with its root.
    const trustedAccessWritten = await writeTrustedAccess(
      layout,
      runtimeOptions.trustedAccess,
      input.productionUrl,
    );
    await prepareActivityControlChannels(layout.controlDirectory, runtimeOptions);
    await writeTaskApiConfig(layout.controlDirectory, runtimeOptions.taskApi);
    const sessionDirectory = await linkSessionDirectory(
      layout.controlDirectory,
      runtimeOptions.sessionDirectory,
    );
    await prepareChildOwnership(layout, context.childUid, context.childGid, sessionDirectory);
    return { layout, repositoryRoot, encryptionKey, inputPath, trustedAccessWritten };
  } catch (error) {
    await removeTaskRoot(layout.taskRoot);
    throw error;
  }
}

export async function runActivityInSandbox(
  context: SandboxRuntimeContext,
  inputValue: ActivityRuntimeInput,
  onEvent: (event: ActivityRuntimeEvent) => void | Promise<void>,
  signal: AbortSignal,
  runtimeOptions: ActivityRuntimeOptions,
): Promise<ActivityDockerRunResult> {
  const input = validateActivityRuntimeInput(inputValue);
  const { layout, repositoryRoot, encryptionKey, inputPath, trustedAccessWritten } =
    await prepareActivityTask(context, input, runtimeOptions);
  const humanAuthPassword = randomBytes(24).toString("base64url");
  const sensitiveValues = [
    humanAuthPassword,
    ...(runtimeOptions.trustedAccess ? [runtimeOptions.trustedAccess.headerValue] : []),
  ];
  let lastSequence = 0;
  try {
    await reportControlMount(context, layout.controlDirectory, runtimeOptions);
    const result = await dispatchProcess(context, layout, {
      script: context.activityRunnerScript,
      encryptionKey,
      humanAuthPassword,
      inputPath,
      repositoryRoot,
      trustedAccessWritten,
      sensitiveValues,
      signal,
      parser: new ActivityNdjsonParser(sensitiveValues),
      onEvent: async (event) => {
        if (event.activityId !== input.activityId) {
          throw new Error("Activity runtime emitted an event for another Activity.");
        }
        if (event.sequence <= lastSequence) {
          throw new Error("Activity runtime event sequence is not monotonic.");
        }
        lastSequence = event.sequence;
        const stream = activityBrowserStream(event, context.resolveBrowserStream, input.activityId);
        await onEvent(stream === null
          ? event
          : { ...event, safeData: { ...event.safeData, ...await stream } });
      },
    });
    const activityResult = await readActivityResultFile(
      layout.outputDirectory,
      input,
      runtimeOptions.trustedAccess ? [runtimeOptions.trustedAccess.headerValue] : [],
      result,
    );
    return {
      status: resultStatus(result.exitCode, result.aborted, activityResult),
      exitCode: result.exitCode,
      outputDirectory: layout.outputDirectory,
      result: activityResult,
      stderrTail: result.stderrTail || null,
    };
  } catch (error) {
    await removeTaskRoot(layout.taskRoot);
    throw error;
  } finally {
    await Promise.all([
      rm(layout.inputDirectory, { recursive: true, force: true }),
      rm(join(layout.controlDirectory, "cancel"), { force: true }),
    ]);
  }
}
