import {
  sandboxChildSettings,
  sandboxRuntimePaths,
  type SandboxRuntimeContext,
  type VercelSandboxRuntimeAdapterOptions,
  type VercelSandboxRuntimeAdapters,
} from "./configuration.ts";
import { runActivityInSandbox } from "./run-activity.ts";
import { runSuiteInSandbox } from "./run-suite.ts";

export function createVercelSandboxRuntimeAdapters(
  options: VercelSandboxRuntimeAdapterOptions = {},
): VercelSandboxRuntimeAdapters {
  const context: SandboxRuntimeContext = {
    ...sandboxRuntimePaths(options),
    ...sandboxChildSettings(options),
    environment: options.environment,
    resolveBrowserStream: options.resolveBrowserStream,
  };

  return {
    runSuite(inputValue, onEvent, signal, runtimeOptions = {}) {
      return runSuiteInSandbox(context, inputValue, onEvent, signal, runtimeOptions);
    },

    runActivity(inputValue, onEvent, signal, runtimeOptions = {}) {
      return runActivityInSandbox(context, inputValue, onEvent, signal, runtimeOptions);
    },
  };
}
