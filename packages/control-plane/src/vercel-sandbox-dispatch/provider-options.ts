import { randomBytes } from "node:crypto";

import { Sandbox } from "@vercel/sandbox";

import { type HostedRuntimeConfiguration, hostedConfiguration } from "../configuration.ts";
import type { VercelSandboxFactory } from "../vercel-sandbox-contract.ts";
import { publicOrigin } from "./origins.ts";
import type { RuntimeBundle } from "./runtime-bundle.ts";

export interface VercelSandboxProviderOptions {
  /** The runner image every task Sandbox is created from; the configured one otherwise. */
  runnerImage?: string;
  sandboxFactory?: VercelSandboxFactory;
  /** The deployment's configuration (configuration.ts); this process's otherwise. */
  configuration?: HostedRuntimeConfiguration;
  streamToken?: () => string;
  /** The release's code layer; null runs the code the image booted with. */
  runtimeBundle?: RuntimeBundle | null;
}

/**
 * Every option the provider's acquire and launch steps read, resolved once
 * when the provider is built, so one provider keeps answering from the
 * configuration it was created with.
 */
export interface VercelSandboxProviderSettings {
  configuration: HostedRuntimeConfiguration;
  runnerImage: string;
  sandboxFactory: VercelSandboxFactory;
  streamToken: () => string;
  runtimeBundle: RuntimeBundle | null;
}

/**
 * The console's origin: where a launch rehosts its Workflow webhook, and
 * where a task Sandbox's forward rule sends its job API calls.
 */
export function shipbashPublicOrigin(configuration: HostedRuntimeConfiguration): string {
  return publicOrigin(configuration.publicUrl);
}

export function resolveVercelSandboxProviderOptions(
  options: VercelSandboxProviderOptions,
): VercelSandboxProviderSettings {
  const configuration = options.configuration ?? hostedConfiguration();
  return {
    configuration,
    runnerImage: options.runnerImage ?? configuration.hosted.runnerImage,
    sandboxFactory: options.sandboxFactory ?? Sandbox,
    streamToken: options.streamToken ?? (() => randomBytes(32).toString("base64url")),
    runtimeBundle: options.runtimeBundle === undefined ? configuration.hosted.runtimeBundle : options.runtimeBundle,
  };
}
