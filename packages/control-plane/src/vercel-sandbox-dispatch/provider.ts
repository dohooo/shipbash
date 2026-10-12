import { acquireVercelSandboxWorkspace } from "./acquire.ts";
import type { VercelSandboxExecutionProvider } from "./execution-contract.ts";
import { launchVercelSandboxCommand } from "./launch.ts";
import {
  type VercelSandboxProviderOptions,
  resolveVercelSandboxProviderOptions,
} from "./provider-options.ts";

export function createVercelSandboxExecutionProvider(
  options: VercelSandboxProviderOptions = {},
): VercelSandboxExecutionProvider {
  const settings = resolveVercelSandboxProviderOptions(options);

  return {
    acquire: (rawInput) => acquireVercelSandboxWorkspace(settings, rawInput),
    launch: (sandbox, rawInput, completionWebhookUrl) => launchVercelSandboxCommand(
      settings,
      sandbox,
      rawInput,
      completionWebhookUrl,
    ),
  };
}
