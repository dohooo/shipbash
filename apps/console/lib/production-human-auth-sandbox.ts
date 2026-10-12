/**
 * The Vercel Sandbox as the authentication handoff sees it: the narrow surface
 * it actually uses, the client behind that surface, and the two things every
 * caller needs from a command — its status, and how to stop it.
 *
 * Nothing here knows what a handoff is. It is the transport the rest of the
 * handoff is written against.
 */
import type { Sandbox } from "@vercel/sandbox";

import { hostedConfiguration } from "@shipbash/control-plane/configuration";
import { sandboxNetworkPolicy } from "@shipbash/control-plane/vercel-sandbox-network-policy";

import { propertyOf } from "./property-of";
import { COMMAND_STOP_TIMEOUT_MS } from "./production-human-auth-paths";
import {
  sandboxAgentCommand,
  type SandboxAgentCommandInput,
} from "@shipbash/control-plane/vercel-sandbox-dispatch/sandbox-agent-command";

export interface SandboxCommandResult {
  readonly cmdId: string;
  readonly exitCode: number | null;
  wait(input?: { signal?: AbortSignal }): Promise<{ exitCode: number | null }>;
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
}

export interface ProductionHumanAuthSandbox {
  readonly name: string;
  readonly status: Sandbox["status"];
  domain(port: number): string;
  runCommand(input: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    detached?: boolean;
  }): Promise<SandboxCommandResult>;
  getCommand(commandId: string): Promise<SandboxCommandResult>;
  writeFiles(files: Array<{ path: string; content: Buffer | string; mode?: number }>): Promise<void>;
  readTextFile(path: string): Promise<string | null>;
  /** The file's bytes as written, for the sealed state the text read would mangle. */
  readFile(path: string): Promise<Buffer | null>;
  stop(): Promise<void>;
  delete(): Promise<void>;
}

export interface ProductionHumanAuthSandboxFactory {
  /** The ephemeral Sandbox one handoff runs in, created from the runner image. */
  create(input: {
    name: string;
    image: string;
    timeout: number;
    ports: number[];
    persistent: false;
  }): Promise<ProductionHumanAuthSandbox>;
  /** The named Sandbox as it stands, never resumed, or null when it is gone. */
  get(name: string): Promise<ProductionHumanAuthSandbox | null>;
}

/**
 * The factory over a Sandbox client: the SDK in production, a mock
 * elsewhere. Every Sandbox it creates runs under the firewall policy that injects
 * the model, Jev and runtime bundle keys (vercel-sandbox-network-policy.ts),
 * so none of them is handed to the Sandbox itself.
 */
function humanAuthSandboxFactory(client: typeof Sandbox): ProductionHumanAuthSandboxFactory {
  function wrap(sandbox: Sandbox): ProductionHumanAuthSandbox {
    return {
      name: sandbox.name,
      get status() {
        return sandbox.status;
      },
      domain: (port) => sandbox.domain(port),
      runCommand: (input) => sandbox.runCommand(input),
      getCommand: (commandId) => sandbox.getCommand(commandId),
      writeFiles: (files) => sandbox.writeFiles(files),
      async readTextFile(path) {
        const value = await sandbox.readFileToBuffer({ path });
        return value?.toString("utf8") ?? null;
      },
      readFile: (path) => sandbox.readFileToBuffer({ path }),
      async stop() {
        await sandbox.stop();
      },
      async delete() {
        await sandbox.delete();
      },
    };
  }

  return {
    create: async (input) => {
      const { agents, hosted } = hostedConfiguration();
      return wrap(await client.create({
        ...input,
        networkPolicy: sandboxNetworkPolicy(agents, { runtimeBundle: hosted.runtimeBundle }),
      }));
    },
    async get(name) {
      try {
        return wrap(await client.get({ name, resume: false }));
      } catch (error) {
        if (sandboxHttpStatus(error) === 404) return null;
        throw error;
      }
    },
  };
}

export async function defaultSandboxFactory(): Promise<ProductionHumanAuthSandboxFactory> {
  const { Sandbox: client } = await import("@vercel/sandbox");
  return humanAuthSandboxFactory(client);
}

/** A handoff Sandbox has nothing to keep once the handoff ends: stopped and deleted. */
export async function discardSandbox(sandbox: Pick<ProductionHumanAuthSandbox, "stop" | "delete">): Promise<void> {
  await sandbox.stop().catch(() => undefined);
  await sandbox.delete().catch(() => undefined);
}

/** The HTTP status a Sandbox client error carries, when it carries one at all. */
export function sandboxHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("response" in error)) return null;
  const status = propertyOf(error.response, "status");
  return Number.isInteger(status) ? Number(status) : null;
}

export function runAsSandboxAgent(
  sandbox: ProductionHumanAuthSandbox,
  input: SandboxAgentCommandInput,
): Promise<SandboxCommandResult> {
  return sandbox.runCommand(sandboxAgentCommand(input));
}

export async function stopCommand(
  command: SandboxCommandResult,
  signal: "SIGTERM" | "SIGKILL",
): Promise<{ exitCode: number | null } | null> {
  if (command.exitCode !== null) return command;
  await command.kill(signal);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COMMAND_STOP_TIMEOUT_MS);
  timeout.unref();
  try {
    return await command.wait({ signal: controller.signal });
  } catch {
    if (signal !== "SIGKILL") await command.kill("SIGKILL").catch(() => undefined);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
