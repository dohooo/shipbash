import {
  type ValidatedVercelSandboxDispatchInput,
  type VercelSandboxDispatchInput,
  type VercelSandboxWorkspace,
  validateVercelSandboxDispatchInput,
} from "../vercel-sandbox-contract.ts";
import type { HostedRuntimeConfiguration } from "../configuration.ts";
import { sandboxAgentEnvironment } from "../vercel-sandbox-network-policy.ts";
import type { VercelSandboxLaunch } from "./execution-contract.ts";
import { browserStreamPath, sandboxBrowserStreamUrl } from "./origins.ts";
import { type VercelSandboxProviderSettings, shipbashPublicOrigin } from "./provider-options.ts";
import { runtimeLaunch } from "./runtime-bundle.ts";
import { vercelSandboxWorkspaceName } from "./workspace-names.ts";

/** The addresses one launch derives before it can name them to the runner. */
interface DispatchCommandAddresses {
  shipbashPublicOrigin: string;
  webhookUrl: URL;
  browserStreamUrl: string;
  streamPath: string;
}

/**
 * The environment the in-Sandbox runner starts with: the job it runs and
 * where it reports, and nothing secret. The job API takes the Sandbox's
 * identity from its firewall, and the model and Jev keys are placeholders
 * the firewall replaces on the way out (vercel-sandbox-network-policy.ts).
 */
function dispatchCommandEnvironment(
  configuration: HostedRuntimeConfiguration,
  input: ValidatedVercelSandboxDispatchInput,
  addresses: DispatchCommandAddresses,
): Record<string, string> {
  return {
    SHIPBASH_DISPATCH_JOB_ID: input.jobId,
    SHIPBASH_DISPATCH_ATTEMPT_ID: input.dispatchAttemptId,
    SHIPBASH_DISPATCH_IDENTITY_HASH: input.identityHash,
    SHIPBASH_DISPATCH_KIND: input.kind,
    SHIPBASH_DISPATCH_TIMEOUT_MS: String(input.timeoutMs),
    SHIPBASH_DISPATCH_RESULT_WEBHOOK_URL: addresses.webhookUrl.toString(),
    ...sandboxAgentEnvironment(configuration),
    SHIPBASH_BROWSER_STREAM_URL: addresses.browserStreamUrl,
    SHIPBASH_BROWSER_STREAM_PATH: addresses.streamPath,
    SHIPBASH_BROWSER_STREAM_ALLOWED_ORIGIN: addresses.shipbashPublicOrigin,
    SHIPBASH_BROWSER_STREAM_PUBLIC_PORT: "9224",
  };
}

export async function launchVercelSandboxCommand(
  options: VercelSandboxProviderSettings,
  sandbox: VercelSandboxWorkspace,
  rawInput: VercelSandboxDispatchInput,
  completionWebhookUrl: string,
): Promise<VercelSandboxLaunch> {
  const { configuration } = options;
  const input = validateVercelSandboxDispatchInput(rawInput);
  const origin = shipbashPublicOrigin(configuration);
  // Workflow builds webhook URLs on VERCEL_URL, which is the
  // deployment-specific host protected by Vercel Deployment Protection.
  // Sandbox callbacks to that host are rejected with 401 before they reach
  // the app, so rehost the webhook on the public production origin, which
  // serves the same webhook route.
  const webhookUrl = new URL(completionWebhookUrl);
  const publicUrl = new URL(origin);
  webhookUrl.protocol = publicUrl.protocol;
  webhookUrl.host = publicUrl.host;
  const streamPath = browserStreamPath(options.streamToken());
  const browserStreamUrl = sandboxBrowserStreamUrl(sandbox.domain(9224), streamPath);
  // The installed release when one is configured, the image's own code otherwise.
  const runtime = options.runtimeBundle
    ? runtimeLaunch(options.runtimeBundle)
    : { script: "/shipbash/runtime/vercel-dispatch-runner.mjs", cwd: "/shipbash/runtime", env: {} };
  const command = await sandbox.runCommand({
    cmd: "node",
    args: [runtime.script],
    cwd: runtime.cwd,
    detached: true,
    timeoutMs: input.timeoutMs,
    env: {
      ...dispatchCommandEnvironment(configuration, input, {
        shipbashPublicOrigin: origin,
        webhookUrl,
        browserStreamUrl,
        streamPath,
      }),
      ...runtime.env,
    },
  });
  return {
    sandboxName: vercelSandboxWorkspaceName(input),
    commandId: command.cmdId,
  };
}
