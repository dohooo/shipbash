/**
 * What a local runner container is handed to reach the agent services: the
 * variables that name them, forwarded by name so docker copies each value
 * from this process's environment and no key lands in an argument list, and
 * Codex's system layer, written into the run's input directory and mounted
 * read-only where Codex reads it (codex-config.mjs).
 */
import { join } from "node:path";

import { AGENT_SERVICE_VARIABLES } from "@shipbash/contracts/runtime/agent-model.mjs";
import { CODEX_SYSTEM_CONFIG_PATH, writeCodexConfig } from "@shipbash/runner/runtime/codex-config.mjs";

import { configuration } from "./configuration.ts";

const CODEX_CONFIG_FILE = "codex-config.toml";

/** `--env NAME` for each agent service variable. */
export function agentServiceEnvArgs(): string[] {
  return Object.values(AGENT_SERVICE_VARIABLES).flatMap((name) => ["--env", name]);
}

/** The read-only mount of the run's Codex configuration over Codex's system layer. */
export function codexConfigMountArgs(inputDirectory: string): string[] {
  return ["--mount", `type=bind,src=${join(inputDirectory, CODEX_CONFIG_FILE)},dst=${CODEX_SYSTEM_CONFIG_PATH},readonly`];
}

/**
 * Writes the run's Codex configuration, for the gateway this process's
 * configuration names, where the mount reads it. The Docker runtime's per-run
 * options are shared with the Sandbox runtime, which writes its own, so the
 * gateway is read through the configuration reader rather than handed in.
 */
export function writeRunCodexConfig(inputDirectory: string): Promise<void> {
  return writeCodexConfig(join(inputDirectory, CODEX_CONFIG_FILE), configuration().agents.model);
}
