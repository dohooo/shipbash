/**
 * The Sandbox one Job runs in: created fresh from the runner image under its
 * firewall policy, handed the release's runtime, and deleted when the Job
 * ends. Nothing is forked and nothing persists between Jobs; everything a
 * task needs arrives by injection here or at launch, and through the job API.
 */
import { jobApiForwardUrl } from "@shipbash/contracts/runtime/job-api-contract.mjs";
import {
  type ValidatedVercelSandboxDispatchInput,
  type VercelSandboxDispatchInput,
  type VercelSandboxWorkspace,
  validateVercelSandboxDispatchInput,
} from "../vercel-sandbox-contract.ts";
import { sandboxNetworkPolicy } from "../vercel-sandbox-network-policy.ts";
import { sandboxHttpStatus } from "./http-status.ts";
import { type VercelSandboxProviderSettings, shipbashPublicOrigin } from "./provider-options.ts";
import { ensureRuntime } from "./runtime-bundle.ts";
import { vercelSandboxWorkspaceName } from "./workspace-names.ts";

async function discardSandboxAfterInitializationFailure(
  sandbox: Pick<VercelSandboxWorkspace, "delete" | "stop">,
): Promise<void> {
  await sandbox.stop().catch(() => undefined);
  await sandbox.delete().catch(() => undefined);
}

/** The ephemeral Sandbox one Job runs in, created from the runner image under the Job's deterministic name. */
async function attachTaskSandbox(
  options: VercelSandboxProviderSettings,
  input: ValidatedVercelSandboxDispatchInput,
): Promise<{ sandbox: VercelSandboxWorkspace; created: boolean }> {
  const { sandboxFactory } = options;
  const name = vercelSandboxWorkspaceName(input);
  // Read before the Sandbox exists, so a step missing a key creates nothing.
  const { configuration } = options;
  const networkPolicy = sandboxNetworkPolicy(configuration.agents, {
    runtimeBundle: options.runtimeBundle,
    jobApi: {
      host: configuration.hosted.jobApiHost,
      forwardUrl: jobApiForwardUrl(shipbashPublicOrigin(configuration), input.jobId),
    },
  });
  try {
    const sandbox = await sandboxFactory.create({
      image: options.runnerImage,
      name,
      timeout: input.timeoutMs,
      ports: [9224],
      persistent: false,
      // The console's own region (vercel.json), which sits beside the
      // database, not the Sandbox default of iad1: the worker talks to the
      // database on every event, and a coast away each round trip cost ~100 ms.
      ...(configuration.hosted.sandboxRegion ? { region: configuration.hosted.sandboxRegion } : {}),
      // The Sandbox's lifetime starts here, so its deadline is stamped here —
      // into the Sandbox's own environment, which every command inherits and
      // a retried acquire finds intact — and the Activity runner measures its
      // wall-clock ceiling from it.
      env: { SHIPBASH_DISPATCH_DEADLINE_AT: String(Date.now() + input.timeoutMs) },
      // The job API reached by the Sandbox's identity, the keys injected on
      // the way out: nothing secret enters the VM. A reattach below keeps the
      // policy the Sandbox was created with.
      networkPolicy,
    });
    return { sandbox, created: true };
  } catch (error) {
    // A retried Workflow acquire step must attach to the deterministic
    // task Sandbox created by its first attempt instead of orphaning it or
    // starting a second Agent.
    if (sandboxHttpStatus(error) !== 409) throw error;
    return { sandbox: await sandboxFactory.get({ name, resume: true }), created: false };
  }
}

/**
 * The task Sandbox with the release's runtime installed. The install is
 * idempotent, so a retried acquire that reattached repeats it safely; a
 * Sandbox this attempt created is discarded when its install fails.
 */
export async function acquireVercelSandboxWorkspace(
  options: VercelSandboxProviderSettings,
  rawInput: VercelSandboxDispatchInput,
): Promise<VercelSandboxWorkspace> {
  const input = validateVercelSandboxDispatchInput(rawInput);
  const { sandbox, created } = await attachTaskSandbox(options, input);
  try {
    await ensureRuntime(sandbox, options.runtimeBundle);
  } catch (error) {
    if (created) await discardSandboxAfterInitializationFailure(sandbox);
    throw error;
  }
  return sandbox;
}
